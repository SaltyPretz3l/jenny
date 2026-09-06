const test = require('node:test');
const assert = require('node:assert/strict');

const surfaceLayout = require('../renderer/app/renderer-app-surface-layout.js');

function makeLayoutElement(rect) {
  return {
    rect: { ...rect },
    getBoundingClientRect() { return { ...this.rect }; },
    querySelectorAll() { return []; },
  };
}

test('empty-chat broad content allows ambient effects while prompt controls block activation', () => {
  const sceneRect = { left: 0, top: 0, width: 800, height: 600 };
  const heroStage = makeLayoutElement(sceneRect);
  const heroStack = makeLayoutElement({ left: 120, top: 130, width: 560, height: 240 });
  const promptButton = makeLayoutElement({ left: 220, top: 280, width: 160, height: 40 });
  const chatView = makeLayoutElement(sceneRect);
  chatView.querySelectorAll = (selector) => {
    if (selector.includes('.hero-stage')) return [heroStage];
    if (selector.includes('.chat-empty .hero-stack')) return [heroStack];
    if (selector.includes('button')) return [promptButton];
    return [];
  };
  const publisher = surfaceLayout.createSurfaceLayoutPublisher({
    state: { ui: { activeView: 'chat' } },
    windowRef: {},
    dom: {
      chatView,
      chatSurfaceEffects: makeLayoutElement(sceneRect),
      chatSurfaceEffectLeft: makeLayoutElement(sceneRect),
      chatSurfaceEffectRight: makeLayoutElement({ left: 800, top: 0, width: 0, height: 600 }),
    },
  });

  const layout = publisher.getSnapshot().layout;
  const hasHeroStack = (regions) => regions.some((rect) => rect.left === 120 && rect.top === 130
    && rect.width === 560 && rect.height === 240);
  const hasPromptButton = (regions) => regions.some((rect) => rect.left === 220 && rect.top === 280
    && rect.width === 160 && rect.height === 40);
  assert.equal(hasHeroStack(layout.interactionBlockRects), false,
    'the broad empty hero does not suppress ambient hover');
  assert.equal(hasHeroStack(layout.paintOcclusionRects), false,
    'the broad empty hero does not become a binary paint cutout');
  assert.equal(hasHeroStack(layout.spawnAvoidanceRects), false,
    'the broad empty hero does not repel effect primitives');
  assert.equal(hasPromptButton(layout.interactionBlockRects), true,
    'the prompt control remains activation-blocked');
  assert.equal(hasPromptButton(layout.paintOcclusionRects), false);
  assert.equal(hasPromptButton(layout.spawnAvoidanceRects), false);
});

test('thread content blocks input without erasing or repelling background effects', () => {
  const sceneRect = { left: 0, top: 0, width: 800, height: 600 };
  const threadColumn = makeLayoutElement({ left: 180, top: 0, width: 440, height: 600 });
  const composerWrap = makeLayoutElement({ left: 200, top: 500, width: 400, height: 80 });
  const paintMarker = makeLayoutElement({ left: 40, top: 40, width: 80, height: 60 });
  const spawnMarker = makeLayoutElement({ left: 680, top: 40, width: 80, height: 60 });
  const chatView = makeLayoutElement(sceneRect);
  chatView.querySelectorAll = (selector) => {
    const matches = [];
    if (selector.includes('.chat-thread-column')) matches.push(threadColumn);
    if (selector.includes('.composer-wrap')) matches.push(composerWrap);
    if (selector.includes('[data-surface-effect-paint-occlusion]')) matches.push(paintMarker);
    if (selector.includes('[data-surface-effect-spawn-avoidance]')) matches.push(spawnMarker);
    return matches;
  };
  const publisher = surfaceLayout.createSurfaceLayoutPublisher({
    state: { ui: { activeView: 'chat' } },
    windowRef: {},
    dom: {
      chatView,
      chatSurfaceEffects: makeLayoutElement(sceneRect),
      chatSurfaceEffectLeft: makeLayoutElement(sceneRect),
      chatSurfaceEffectRight: makeLayoutElement({ left: 800, top: 0, width: 0, height: 600 }),
    },
  });

  const layout = publisher.getSnapshot().layout;
  const hasThreadColumn = (regions) => regions.some((rect) => rect.left === 180
    && rect.top === 0 && rect.width === 440 && rect.height === 600);
  const hasComposer = (regions) => regions.some((rect) => rect.left === 200
    && rect.top === 500 && rect.width === 400 && rect.height === 80);
  const hasPaintMarker = (regions) => regions.some((rect) => rect.left === 40
    && rect.top === 40 && rect.width === 80 && rect.height === 60);
  const hasSpawnMarker = (regions) => regions.some((rect) => rect.left === 680
    && rect.top === 40 && rect.width === 80 && rect.height === 60);

  assert.equal(hasThreadColumn(layout.interactionBlockRects), false,
    'the broad timeline shell does not geometrically suppress hover when hidden or populated');
  assert.equal(hasThreadColumn(layout.paintOcclusionRects), false,
    'the timeline no longer becomes a binary paint cutout');
  assert.equal(hasThreadColumn(layout.spawnAvoidanceRects), false,
    'the timeline no longer repels effect primitives from its full rectangle');
  for (const regions of [
    layout.interactionBlockRects,
    layout.paintOcclusionRects,
    layout.spawnAvoidanceRects,
  ]) {
    assert.equal(hasComposer(regions), true, 'the composer remains fully protected');
  }
  assert.equal(hasPaintMarker(layout.paintOcclusionRects), true,
    'explicit paint-occlusion markers remain protected');
  assert.equal(hasSpawnMarker(layout.spawnAvoidanceRects), true,
    'explicit spawn-avoidance markers remain protected');
});

test('Home content blocks input while card and panel fills provide visual contrast', () => {
  const sceneRect = { left: 0, top: 0, width: 1000, height: 700 };
  const dashboardGrid = makeLayoutElement({ left: 40, top: 40, width: 920, height: 620 });
  const dashboardCard = makeLayoutElement({ left: 60, top: 70, width: 400, height: 220 });
  const homePanel = makeLayoutElement({ left: 540, top: 70, width: 400, height: 220 });
  const homeView = makeLayoutElement(sceneRect);
  homeView.querySelectorAll = (selector) => {
    const matches = [];
    if (selector.includes('.home-dashboard-grid')) matches.push(dashboardGrid);
    if (selector.includes('.dashboard-card')) matches.push(dashboardCard);
    if (selector.includes('.home-panel')) matches.push(homePanel);
    return matches;
  };
  const publisher = surfaceLayout.createSurfaceLayoutPublisher({
    state: { ui: { activeView: 'home' } },
    windowRef: {},
    dom: { homeView },
  });

  const layout = publisher.getSnapshot().layout;
  const hasDashboardCard = (regions) => regions.some((rect) => rect.left === 60
    && rect.top === 70 && rect.width === 400 && rect.height === 220);
  const hasHomePanel = (regions) => regions.some((rect) => rect.left === 540
    && rect.top === 70 && rect.width === 400 && rect.height === 220);
  assert.equal(layout.interactionBlockRects.some((rect) => rect.left === 40 && rect.top === 40
    && rect.width === 920 && rect.height === 620), false,
    'the dashboard grid container does not suppress open-space interaction');
  assert.equal(hasDashboardCard(layout.interactionBlockRects), true,
    'dashboard cards remain input blockers');
  assert.equal(hasHomePanel(layout.interactionBlockRects), true,
    'Home panels remain input blockers');
  for (const regions of [layout.paintOcclusionRects, layout.spawnAvoidanceRects]) {
    assert.equal(hasDashboardCard(regions), false,
      'dashboard-card translucency reveals effects instead of erasing them');
    assert.equal(hasHomePanel(regions), false,
      'Home-panel translucency reveals effects instead of erasing them');
  }
});
