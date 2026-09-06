const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createCompanionActionUtils } = require('../renderer/features/renderer-companion-action-utils.js');

test('a rejected loop resolve restores the surviving card interaction state', async () => {
  const dom = new JSDOM('<div id="loops"><article class="memory-commitment-item" data-follow-up-id="followup-1"><button data-companion-action-id="resolve_follow_up:followup-1">Done</button></article></div>');
  const documentRef = dom.window.document;
  const loopList = documentRef.getElementById('loops');
  const card = loopList.querySelector('.memory-commitment-item');
  const action = {
    id: 'resolve_follow_up:followup-1',
    type: 'resolve_follow_up',
    label: 'Done',
    followUpId: 'followup-1',
  };
  const utils = createCompanionActionUtils({
    documentRef,
    windowRef: {
      getComputedStyle: () => ({ animationName: 'none' }),
      jennyShell: {
        companion: {
          resolveFollowUp: async () => { throw new Error('resolve failed'); },
        },
      },
    },
    dom: { homeOpenLoopList: loopList },
    callbacks: {
      getCompanionState: () => ({ openLoopsBoard: { active: [{ actions: [action] }] } }),
    },
  });

  await utils.handleHomeClick({
    target: loopList.querySelector('button'),
    preventDefault() {},
  });

  assert.equal(card.hasAttribute('data-loop-resolving'), false);
});
