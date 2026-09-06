.PHONY: lint lint-fix test-sidecar test-sidecar-cov typecheck-py dev test-electron lint-ts check-boundary check-size check-no-bom check-hotspot-size check-protocol-contract check-stdout check-raw-html check-os-getenv check-import-fanout check-complexity-contract check-policy check-backend check-all ci clean

# --- Python sidecar ---
lint:
	python -m ruff check sidecar/ tests/sidecar/
	python -m ruff format --check sidecar/ tests/sidecar/

lint-fix:
	python -m ruff check --fix sidecar/ tests/sidecar/
	python -m ruff format sidecar/ tests/sidecar/

test-sidecar:
	python -m pytest tests/sidecar/ -v --tb=short

test-sidecar-cov:
	python -m pytest tests/sidecar/ --cov=sidecar --cov-report=term-missing

typecheck-py:
	python -m mypy sidecar/

# --- Electron ---
dev:
	npm run dev

test-electron:
	npm test

lint-ts:
	npm run lint

# --- Enforcement checks (cross-platform via Python scripts) ---
check-boundary:
	python scripts/checks/check_boundary.py

check-size:
	python scripts/checks/check_file_size.py

check-no-bom:
	python scripts/checks/check_no_utf8_bom.py

check-hotspot-size:
	python scripts/checks/check_hotspot_size.py

check-protocol-contract:
	python scripts/checks/check_protocol_contract.py

check-stdout:
	python scripts/checks/check_no_stdout_print.py

check-raw-html:
	python scripts/checks/check_no_raw_html_primitives.py

check-os-getenv:
	python scripts/checks/check_no_os_getenv.py

check-import-fanout:
	python scripts/checks/check_import_fanout.py

check-complexity-contract:
	python scripts/checks/check_complexity_contract.py

check-policy:
	python scripts/checks/run_all.py

check-backend:
	python scripts/checks/run_backend_contract_tests.py

check-all:
	python scripts/checks/run_ci.py

ci: check-all
	@echo "All CI checks passed."

clean:
	python scripts/checks/clean_workspace.py
