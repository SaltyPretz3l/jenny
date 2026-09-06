use std::sync::Arc;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use wasmtime::component::{Component, HasSelf, Linker};
use wasmtime::{Config, Engine, Store};

use crate::broker_channel::InvocationBroker;
use crate::capability_abi::{InvocationState, RestrictedHost};
use crate::limits::{COMPONENT_BYTES, FUEL_PER_INVOCATION};

pub struct RestrictedRuntime {
    engine: Engine,
    component: Component,
}

pub struct InvocationOutcome {
    pub result: String,
}

impl RestrictedRuntime {
    pub fn load(component_bytes: &[u8]) -> Result<Self> {
        if component_bytes.is_empty() || component_bytes.len() > COMPONENT_BYTES {
            bail!("component_bytes_rejected");
        }
        let mut config = Config::new();
        config.wasm_component_model(true);
        config.consume_fuel(true);
        config.epoch_interruption(true);
        config.cranelift_nan_canonicalization(true);
        let engine = Engine::new(&config).map_err(|_| anyhow!("engine_configuration_rejected"))?;
        let component = Component::new(&engine, component_bytes)
            .map_err(|_| anyhow!("component_validation_rejected"))?;
        Ok(Self { engine, component })
    }

    pub fn invoke(
        &self,
        input: &str,
        timeout_ms: u64,
        broker: Arc<InvocationBroker>,
    ) -> Result<InvocationOutcome> {
        if input.len() > 64 * 1024 || timeout_ms == 0 || timeout_ms > 120_000 {
            bail!("invocation_budget_rejected");
        }
        let mut linker = Linker::new(&self.engine);
        RestrictedHost::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
            .map_err(|_| anyhow!("capability_linker_rejected"))?;
        let state = InvocationState {
            deadline: Some(Instant::now() + Duration::from_millis(timeout_ms)),
            broker: Some(broker),
            ..InvocationState::default()
        };
        let mut store = Store::new(&self.engine, state);
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(FUEL_PER_INVOCATION)
            .map_err(|_| anyhow!("fuel_configuration_rejected"))?;
        store.set_epoch_deadline(1);
        let (cancel_timeout, timeout_wait) = mpsc::channel();
        let timeout_engine = self.engine.clone();
        let timeout = Duration::from_millis(timeout_ms);
        let timeout_thread = thread::spawn(move || {
            if timeout_wait.recv_timeout(timeout).is_err() {
                timeout_engine.increment_epoch();
            }
        });
        let called = (|| -> Result<_> {
            let bindings = RestrictedHost::instantiate(&mut store, &self.component, &linker)
                .map_err(|_| anyhow!("component_instantiation_rejected"))?;
            bindings
                .call_invoke(&mut store, input)
                .map_err(|_| anyhow!("component_invocation_failed"))
        })();
        let _ = cancel_timeout.send(());
        let _ = timeout_thread.join();
        let result = called?.map_err(anyhow::Error::msg)?;
        if result.len() > 64 * 1024 {
            bail!("result_budget_exceeded");
        }
        Ok(InvocationOutcome { result })
    }

    pub fn describe(&self) -> Result<String> {
        let mut linker = Linker::new(&self.engine);
        RestrictedHost::add_to_linker::<_, HasSelf<_>>(&mut linker, |state| state)
            .map_err(|_| anyhow!("capability_linker_rejected"))?;
        let mut store = Store::new(&self.engine, InvocationState::default());
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(FUEL_PER_INVOCATION)
            .map_err(|_| anyhow!("fuel_configuration_rejected"))?;
        store.set_epoch_deadline(1);
        let bindings = RestrictedHost::instantiate(&mut store, &self.component, &linker)
            .map_err(|_| anyhow!("component_instantiation_rejected"))?;
        bindings
            .call_describe(&mut store)
            .map_err(|_| anyhow!("component_description_failed"))
    }
}
