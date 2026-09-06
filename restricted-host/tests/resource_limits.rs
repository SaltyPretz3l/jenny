#[test]
fn frozen_resource_limits_match_stage6_budget() {
    let source = include_str!("../src/limits.rs");
    let process_source = include_str!("../src/process_limits.rs");
    let broker_source = include_str!("../src/broker_channel.rs");
    assert!(source.contains("64 * 1024 * 1024"));
    assert!(source.contains("TABLE_ELEMENTS: usize = 10_000"));
    assert!(source.contains("INSTANCES: usize = 4"));
    assert!(process_source.contains("128 * 1024 * 1024"));
    assert!(process_source.contains("JOB_OBJECT_LIMIT_PROCESS_MEMORY"));
    assert!(process_source.contains("ru_maxrss"));
    assert!(broker_source.contains("BACKPRESSURE_ACK_DEADLINE_MS: u64 = 1000"));
}
