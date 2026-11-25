//! One frame of one window through Windows.Graphics.Capture and Direct3D 11.
//!
//! Everything is created per call and released before returning; nothing is cached. Every
//! COM/WinRT failure becomes a `capture_failed` error with a short message that names the step and
//! the HRESULT, never a window title or a path.

use std::cell::Cell;
use std::ffi::c_void;
use std::time::{Duration, Instant};

use windows::core::{factory, Interface};
use windows::Graphics::Capture::{
    Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession,
};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND as WinHwnd, RPC_E_CHANGED_MODE};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE, D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Resource, ID3D11Texture2D,
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE,
    D3D11_MAP_READ, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows_sys::Win32::Foundation::{POINT, RECT};
use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::UI::WindowsAndMessaging::{GetClientRect, IsIconic, IsWindow};

use super::image::{bgra_to_rgba, Rect, Rgba};
use super::{capture_failed, Grabbed};
use crate::protocol::{ErrorCode, ProtoError};

/// How long to wait for the first frame, and how often to look.
const FRAME_WAIT: Duration = Duration::from_millis(1000);
const FRAME_POLL: Duration = Duration::from_millis(5);

fn step_failed(step: &str, error: &windows::core::Error) -> ProtoError {
    capture_failed(&format!("{step} failed (0x{:08x})", error.code().0 as u32))
}

fn raw_hwnd(hwnd: u64) -> *mut c_void {
    hwnd as usize as *mut c_void
}

/// Capture one frame of `hwnd`. With `want_client` the drawn bounds and client rectangle are read
/// right after the frame arrives, so the caller can crop.
pub fn grab(hwnd: u64, want_client: bool) -> Result<Grabbed, ProtoError> {
    check_window(hwnd)?;
    init_winrt()?;
    let (device, context) = create_device()?;
    let winrt_device = wrap_device(&device)?;
    let item = create_item(hwnd)?;
    let size = item
        .Size()
        .map_err(|e| step_failed("capture item size", &e))?;
    if size.Width <= 0 || size.Height <= 0 {
        return Err(capture_failed("window has no size"));
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        1,
        size,
    )
    .map_err(|e| step_failed("frame pool", &e))?;
    let session = pool
        .CreateCaptureSession(&item)
        .map_err(|e| step_failed("capture session", &e))?;
    let capture = Capture { pool, session };
    // Older Windows 10 lacks both; the picture is still right without them.
    let _ = capture.session.SetIsBorderRequired(false);
    let _ = capture.session.SetIsCursorCaptureEnabled(false);
    capture
        .session
        .StartCapture()
        .map_err(|e| step_failed("start capture", &e))?;
    let frame = wait_for_frame(&capture.pool)?;
    let geometry = if want_client {
        Some(bounds_and_client(hwnd)?)
    } else {
        None
    };
    let pixels = read_frame(&device, &context, &frame);
    let _ = frame.Close();
    Ok(Grabbed {
        frame: pixels?,
        geometry,
    })
}

/// The session and pool of one capture, closed when this value goes out of scope.
struct Capture {
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

fn check_window(hwnd: u64) -> Result<(), ProtoError> {
    let handle = raw_hwnd(hwnd);
    // SAFETY: `IsWindow` accepts any handle value, including one that names nothing, and only
    // reads window-manager state.
    if unsafe { IsWindow(handle) } == 0 {
        return Err(ProtoError::new(
            ErrorCode::NoSuchWindow,
            "no window with that handle",
        ));
    }
    // SAFETY: as above, `IsIconic` only reads state for a handle value.
    if unsafe { IsIconic(handle) } != 0 {
        return Err(capture_failed("window is minimised"));
    }
    Ok(())
}

thread_local! {
    static WINRT_READY: Cell<bool> = const { Cell::new(false) };
}

/// Initialise WinRT for this thread as multithreaded, once per thread. A thread that is already
/// initialised (S_FALSE, or another apartment mode) is fine.
fn init_winrt() -> Result<(), ProtoError> {
    if WINRT_READY.with(Cell::get) {
        return Ok(());
    }
    // SAFETY: `RoInitialize` has no preconditions beyond being called on a thread that may hold a
    // COM apartment; the apartment lives as long as the thread.
    match unsafe { RoInitialize(RO_INIT_MULTITHREADED) } {
        Ok(()) => {}
        Err(e) if e.code() == RPC_E_CHANGED_MODE => {}
        Err(e) => return Err(step_failed("winrt init", &e)),
    }
    WINRT_READY.with(|ready| ready.set(true));
    Ok(())
}

fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), ProtoError> {
    let mut last = None;
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        match create_device_with(driver) {
            Ok(pair) => return Ok(pair),
            Err(e) => last = Some(e),
        }
    }
    Err(match last {
        Some(e) => step_failed("d3d device", &e),
        None => capture_failed("d3d device failed"),
    })
}

fn create_device_with(
    driver: D3D_DRIVER_TYPE,
) -> windows::core::Result<(ID3D11Device, ID3D11DeviceContext)> {
    let mut device = None;
    let mut context = None;
    // SAFETY: the out pointers refer to live locals, no adapter or feature-level list is passed,
    // and the module handle is null as required for a non-software driver type.
    unsafe {
        D3D11CreateDevice(
            None::<&IDXGIAdapter>,
            driver,
            HMODULE(std::ptr::null_mut()),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    match (device, context) {
        (Some(device), Some(context)) => Ok((device, context)),
        _ => Err(windows::core::Error::from(
            windows::Win32::Foundation::E_POINTER,
        )),
    }
}

fn wrap_device(device: &ID3D11Device) -> Result<IDirect3DDevice, ProtoError> {
    let dxgi: IDXGIDevice = device.cast().map_err(|e| step_failed("dxgi device", &e))?;
    // SAFETY: `dxgi` is a live DXGI device owned by this call; the function only wraps it.
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
        .map_err(|e| step_failed("winrt device", &e))?;
    inspectable
        .cast()
        .map_err(|e| step_failed("winrt device", &e))
}

fn create_item(hwnd: u64) -> Result<GraphicsCaptureItem, ProtoError> {
    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()
        .map_err(|e| step_failed("capture interop", &e))?;
    // SAFETY: `interop` is a live factory interface; a handle that names no capturable window
    // makes the call return an error rather than cause undefined behaviour.
    unsafe { interop.CreateForWindow::<GraphicsCaptureItem>(WinHwnd(raw_hwnd(hwnd))) }
        .map_err(|e| step_failed("capture item", &e))
}

fn wait_for_frame(pool: &Direct3D11CaptureFramePool) -> Result<Direct3D11CaptureFrame, ProtoError> {
    let started = Instant::now();
    loop {
        if let Ok(frame) = pool.TryGetNextFrame() {
            return Ok(frame);
        }
        if started.elapsed() >= FRAME_WAIT {
            return Err(capture_failed("no frame"));
        }
        std::thread::sleep(FRAME_POLL);
    }
}

/// Copy the frame's texture into a CPU-readable staging texture and read it as packed RGBA.
fn read_frame(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    frame: &Direct3D11CaptureFrame,
) -> Result<Rgba, ProtoError> {
    let content = frame
        .ContentSize()
        .map_err(|e| step_failed("frame size", &e))?;
    let surface = frame
        .Surface()
        .map_err(|e| step_failed("frame surface", &e))?;
    let access: IDirect3DDxgiInterfaceAccess = surface
        .cast()
        .map_err(|e| step_failed("frame texture", &e))?;
    // SAFETY: `access` is the live interface of the frame's surface; `GetInterface` only queries
    // it for the texture behind it.
    let texture: ID3D11Texture2D =
        unsafe { access.GetInterface() }.map_err(|e| step_failed("frame texture", &e))?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: `desc` is a live out structure of the type `GetDesc` fills.
    unsafe { texture.GetDesc(&mut desc) };
    if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM {
        return Err(capture_failed("frame format is not BGRA"));
    }
    let width = u32::try_from(content.Width).unwrap_or(0).min(desc.Width);
    let height = u32::try_from(content.Height).unwrap_or(0).min(desc.Height);
    if width == 0 || height == 0 {
        return Err(capture_failed("frame is empty"));
    }
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    // SAFETY: `desc` describes a plain staging copy of the frame texture, no initial data is
    // given, and `staging` is a live out slot.
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
        .map_err(|e| step_failed("staging texture", &e))?;
    let staging: ID3D11Texture2D =
        staging.ok_or_else(|| capture_failed("staging texture failed"))?;
    let staging_resource: ID3D11Resource = staging
        .cast()
        .map_err(|e| step_failed("staging texture", &e))?;
    let source_resource: ID3D11Resource = texture
        .cast()
        .map_err(|e| step_failed("frame texture", &e))?;
    // SAFETY: both resources are live textures of the same size and format on `device`, and the
    // destination is a staging texture.
    unsafe { context.CopyResource(&staging_resource, &source_resource) };
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: subresource 0 of a staging texture created with CPU read access; `mapped` is a live
    // out structure.
    unsafe { context.Map(&staging_resource, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }
        .map_err(|e| step_failed("map texture", &e))?;
    let pitch = mapped.RowPitch as usize;
    // The last row needs only its pixels, not the padding after them.
    let len = pitch
        .checked_mul(height as usize - 1)
        .and_then(|rows| rows.checked_add(width as usize * 4));
    let rgba = match len {
        Some(len) if !mapped.pData.is_null() => {
            // SAFETY: while the map is held, `pData` points to `RowPitch * Height` readable bytes
            // for this texture, and `height <= desc.Height`, so `pitch * (height - 1) + width * 4`
            // bytes lie inside that region. The slice is dropped before `Unmap`.
            let bytes = unsafe { std::slice::from_raw_parts(mapped.pData as *const u8, len) };
            bgra_to_rgba(bytes, width, height, pitch)
        }
        _ => None,
    };
    // SAFETY: the same subresource that was mapped above; `bytes` no longer exists.
    unsafe { context.Unmap(&staging_resource, 0) };
    let data = rgba.ok_or_else(|| capture_failed("frame could not be read"))?;
    Ok(Rgba {
        width,
        height,
        data,
    })
}

/// The window's drawn bounds and its client area, both in screen pixels.
fn bounds_and_client(hwnd: u64) -> Result<(Rect, Rect), ProtoError> {
    let handle = raw_hwnd(hwnd);
    let mut frame = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `frame` is a live RECT and the size passed is its size, as
    // `DWMWA_EXTENDED_FRAME_BOUNDS` requires; a bad handle makes the call return a failure code.
    let hr = unsafe {
        DwmGetWindowAttribute(
            handle,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&mut frame as *mut RECT).cast::<c_void>(),
            std::mem::size_of::<RECT>() as u32,
        )
    };
    if hr < 0 {
        return Err(capture_failed("window bounds are unknown"));
    }
    let mut client = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `client` is a live RECT; a bad handle makes the call return zero.
    if unsafe { GetClientRect(handle, &mut client) } == 0 {
        return Err(capture_failed("client area is unknown"));
    }
    let mut origin = POINT { x: 0, y: 0 };
    // SAFETY: `origin` is a live POINT; a bad handle makes the call return zero.
    if unsafe { ClientToScreen(handle, &mut origin) } == 0 {
        return Err(capture_failed("client area is unknown"));
    }
    let bounds = Rect {
        x: frame.left,
        y: frame.top,
        width: frame.right.saturating_sub(frame.left),
        height: frame.bottom.saturating_sub(frame.top),
    };
    let client = Rect {
        x: origin.x,
        y: origin.y,
        width: client.right.saturating_sub(client.left),
        height: client.bottom.saturating_sub(client.top),
    };
    Ok((bounds, client))
}
