use std::io::{self, Read, Write};

pub const MAX_CONTROL_FRAME_BYTES: usize = 128 * 1024;
pub const MAX_LOAD_FRAME_BYTES: usize = 86 * 1024 * 1024;

pub fn read_frame(reader: &mut impl Read, maximum: usize) -> io::Result<Vec<u8>> {
    let mut header = [0_u8; 4];
    reader.read_exact(&mut header)?;
    let length = u32::from_be_bytes(header) as usize;
    if length == 0 || length > maximum {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "frame length rejected",
        ));
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload)?;
    Ok(payload)
}

pub fn write_frame(writer: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    writer.write_all(&length.to_be_bytes())?;
    writer.write_all(payload)?;
    writer.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_reject_oversize() {
        let mut bytes = Vec::new();
        write_frame(&mut bytes, b"hello").unwrap();
        assert_eq!(read_frame(&mut bytes.as_slice(), 5).unwrap(), b"hello");
        let oversized = [0_u8, 0, 0, 5];
        assert!(read_frame(&mut oversized.as_slice(), 4).is_err());
    }
}
