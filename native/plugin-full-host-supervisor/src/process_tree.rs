use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct TerminationProof {
    pub known: bool,
    pub reaped: bool,
    pub contained: bool,
    pub tree_empty: bool,
    pub output_readers_terminated: bool,
    pub escalated: bool,
    pub surviving_process_count: u32,
}

impl TerminationProof {
    #[cfg_attr(windows, allow(dead_code))]
    pub fn unproven() -> Self {
        Self {
            known: false,
            reaped: false,
            contained: false,
            tree_empty: false,
            output_readers_terminated: false,
            escalated: false,
            surviving_process_count: 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::TerminationProof;

    #[test]
    fn unproven_cleanup_never_claims_output_reader_termination() {
        let proof = TerminationProof::unproven();
        assert!(!proof.output_readers_terminated);
    }
}
