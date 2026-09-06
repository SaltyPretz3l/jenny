use wasmtime::{ResourceLimiter, Result};

pub const COMPONENT_BYTES: usize = 64 * 1024 * 1024;
pub const LINEAR_MEMORY_BYTES: usize = 64 * 1024 * 1024;
pub const TABLE_ELEMENTS: usize = 10_000;
pub const TABLES: usize = 4;
pub const INSTANCES: usize = 4;
pub const FUEL_PER_INVOCATION: u64 = 25_000_000;

#[derive(Default)]
pub struct HostLimits;

impl ResourceLimiter for HostLimits {
    fn memory_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> Result<bool> {
        Ok(desired <= LINEAR_MEMORY_BYTES)
    }

    fn table_growing(
        &mut self,
        _current: usize,
        desired: usize,
        _maximum: Option<usize>,
    ) -> Result<bool> {
        Ok(desired <= TABLE_ELEMENTS)
    }

    fn instances(&self) -> usize {
        INSTANCES
    }
    fn tables(&self) -> usize {
        TABLES
    }
}
