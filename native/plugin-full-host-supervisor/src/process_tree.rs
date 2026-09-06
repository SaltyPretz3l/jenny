use serde::Serialize;

#[derive(Serialize)]
pub struct TerminationProof {
    pub known: bool,
    pub reaped: bool,
    pub contained: bool,
    pub tree_empty: bool,
    pub escalated: bool,
    pub surviving_process_count: u32,
}

impl TerminationProof {
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unproven() -> Self {
        Self { known: false, reaped: false, contained: false, tree_empty: false,
            escalated: false, surviving_process_count: 0 }
    }
}
