import pytest

from scripts.checks import check_renderer_app_dispose as checker


def check_source(tmp_path, monkeypatch, source):
    path = tmp_path / "tests/example.test.js"
    path.parent.mkdir(exist_ok=True)
    path.write_text(source, encoding="utf-8")
    monkeypatch.setattr(checker, "ROOT", tmp_path)
    monkeypatch.setattr(checker, "TESTS_DIR", path.parent)
    return checker._violations()


@pytest.mark.parametrize("decoy", ["// dispose()", "other.dispose();", "const hint = 'window.close()';"])
def test_unrelated_teardown_does_not_clear_acquisition(tmp_path, monkeypatch, decoy):
    source = "test('leaks', async (t) => { const app = await loadRendererApp(); " + decoy + "\n});"
    assert check_source(tmp_path, monkeypatch, source)


def test_teardown_in_one_test_does_not_clear_another(tmp_path, monkeypatch):
    source = """test('safe', async (t) => {
      const app = await loadRendererApp(); t.after(() => app.dispose());
    });
    test('leaks', async (t) => { const app = await loadRendererApp(); });"""
    violations = check_source(tmp_path, monkeypatch, source)
    assert len(violations) == 1


def test_teardown_in_a_sibling_block_does_not_clear_an_app_of_the_same_name(tmp_path, monkeypatch):
    source = """test('two apps', async (t) => {
      { const app = await loadRendererApp(); t.after(() => app.dispose()); }
      { const app = await loadRendererApp(); }
    });"""
    assert len(check_source(tmp_path, monkeypatch, source)) == 1


def test_each_acquisition_needs_its_own_teardown(tmp_path, monkeypatch):
    source = """test('leaks', async (t) => {
      const a = await loadRendererApp(); const b = await loadRendererApp();
      t.after(() => a.dispose());
    });"""
    assert check_source(tmp_path, monkeypatch, source)


@pytest.mark.parametrize("source", [
    "test('safe', async (t) => { const { dispose } = await loadRendererApp(); t.after(() => dispose()); });",
    "test('safe', async (t) => { const { window } = await loadRendererApp(); t.after(() => window.close()); });",
    "async function helper(t) { const app = await loadRendererApp(); t.after(() => app.dispose()); return app; } test('safe', async t => { await helper(t); });",
])
def test_scoped_harness_teardown_is_accepted(tmp_path, monkeypatch, source):
    assert check_source(tmp_path, monkeypatch, source) == []


def test_direct_callback_and_captured_test_context_are_accepted(tmp_path, monkeypatch):
    source = """test('safe', async (t) => {
      const helper = async () => {
        const { dispose } = await loadRendererApp(); t.after(dispose);
      };
      await helper();
    });"""
    assert check_source(tmp_path, monkeypatch, source) == []


def test_forwarded_apps_are_checked_at_each_caller(tmp_path, monkeypatch):
    source = """async function boot() {
      const app = await loadRendererApp(); return { app };
    }
    test('safe', async (t) => {
      const { app } = await boot(); t.after(app.dispose);
    });
    test('leaks', async (t) => { const { app } = await boot(); });"""
    assert len(check_source(tmp_path, monkeypatch, source)) == 1


def test_nested_test_teardown_does_not_clear_outer_acquisition(tmp_path, monkeypatch):
    source = """test('leaks', async (t) => {
      const app = await loadRendererApp();
      await t.test('inner', async (inner) => { inner.after(() => app.dispose()); });
    });"""
    assert check_source(tmp_path, monkeypatch, source)


def test_forwarding_one_app_does_not_hide_an_abandoned_acquisition(tmp_path, monkeypatch):
    source = """async function boot() {
      const lost = await loadRendererApp();
      const app = await loadRendererApp(); return app;
    }
    test('safe caller', async (t) => { const app = await boot(); t.after(app.dispose); });"""
    assert len(check_source(tmp_path, monkeypatch, source)) == 1


def test_forwarded_multiple_apps_each_need_teardown(tmp_path, monkeypatch):
    source = """async function boot() {
      const first = await loadRendererApp(); const second = await loadRendererApp();
      return { first, second };
    }
    test('leaks', async (t) => {
      const { first, second } = await boot(); t.after(second.dispose);
    });"""
    assert check_source(tmp_path, monkeypatch, source)
