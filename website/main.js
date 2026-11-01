/* Presentation only. No accounts, analytics, storage, or application API calls. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const menu = $('.menu-toggle');
const navigation = $('#navigation');
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('open', open);
});
navigation?.addEventListener('click', event => {
  if (event.target.closest('a')) {
    navigation.classList.remove('open');
    menu?.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && navigation?.classList.contains('open')) {
    navigation.classList.remove('open');
    menu?.setAttribute('aria-expanded', 'false');
    menu?.focus();
  }
});

const connectorDescriptions = {
  "gmail": "Email requests, with the surrounding conversation.",
  "drive": "Project documents and reference material.",
  "github": "Assigned issues, review requests and repository changes.",
  "slack": "Requests from direct and group direct messages.",
  "notion": "Context from the pages you select.",
  "outlook": "Requests from your Outlook inbox."
};
$$('[data-connector]').forEach(button => button.addEventListener('click', () => {
  $$('[data-connector]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  $('#connector-description').textContent = window.unpromptedLanguage?.dynamic.connectors[button.dataset.connector] || connectorDescriptions[button.dataset.connector];
}));

// Manual-activation tabs: arrow keys move focus; Enter/Space activates a tab.
$$('[role="tablist"]').forEach(tablist => {
  tablist.addEventListener('keydown', event => {
    const tabs = $$('[role="tab"]', tablist);
    const current = tabs.indexOf(document.activeElement);
    if (current < 0) return;
    let next;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      tabs.forEach((tab, i) => tab.tabIndex = i === next ? 0 : -1);
      tabs[next].focus();
    }
  });
});

const steps = {
  "notice": {
    "title": "Reply prepared",
    "description": "Edit the reply or preview approval."
  },
  "prepare": {
    "title": "Brief ready",
    "description": "Download a copy to use."
  },
  "verify": {
    "title": "Document checked",
    "description": "The evidence is available on demand."
  }
};

function selectTab(button, panel) {
  $$('[role="tab"]', button.closest('[role="tablist"]')).forEach(tab => {
    tab.setAttribute('aria-selected', String(tab === button));
    tab.tabIndex = tab === button ? 0 : -1;
  });
  panel.setAttribute('aria-labelledby', button.id);
}
function showResult(key) {
  const button = $(`[data-step="${key}"]`);
  if (!button) return;
  selectTab(button, $('#workflow-panel'));
  $$('[data-result-frame]').forEach(frame => {
    const active = frame.dataset.resultFrame === key;
    frame.classList.toggle('is-active', active);
    frame.setAttribute('aria-hidden', String(!active));
  });
  const text = window.unpromptedLanguage?.dynamic.steps[key] || steps[key];
  $('#product-title').textContent = text.title;
  $('#product-description').textContent = text.description;
}
window.unpromptedExperience = { showResult, showScenario };
$$('[data-step]').forEach(button => button.addEventListener('click', () => {
  const key = button.dataset.step;
  if (!window.unpromptedExperience.goToResult?.(key)) showResult(key);
}));

const scenarios = {
  "followup": {
    "image": "followup-change",
    "source": "Source changes",
    "status": "Context rechecked",
    "result": "When the source changes, outdated drafts can be withdrawn.",
    "boundary": "No external action without permission."
  },
  "evidence": {
    "image": "followup-wait",
    "source": "Waiting for a reply",
    "status": "Watching for the answer",
    "result": "Work continues when the missing reply arrives.",
    "boundary": "No external action without permission."
  },
  "change": {
    "image": "followup-resume",
    "source": "Interrupted work",
    "status": "Progress saved",
    "result": "It rechecks the context and continues from saved progress.",
    "boundary": "No external action without permission."
  }
};
function showScenario(key) {
  const button = $(`[data-scenario="${key}"]`);
  if (!button) return;
  selectTab(button, $('#scenario-panel'));
  const scenario = scenarios[key];
  const text = window.unpromptedLanguage?.dynamic.scenarios[key] || scenario;
  $('#scenario-source').textContent = text.source;
  const component = $('#scenario-component');
  component.dataset.component = scenario.image;
  component.innerHTML = window.unpromptedComponents.render(scenario.image);
  $('#example-status').textContent = text.status;
  $('#example-result').textContent = text.result;
  $('#example-boundary').textContent = text.boundary;
}
$$('[data-scenario]').forEach(button => button.addEventListener('click', () => {
  showScenario(button.dataset.scenario);
  window.ScrollTrigger?.refresh();
}));

$('#copy-command')?.addEventListener('click', async () => {
  const status = $('#copy-status');
  try {
    await navigator.clipboard.writeText($('#install-command').textContent);
    status.textContent = window.unpromptedLanguage?.text('copy.success') || 'Commands copied.';
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('#install-command'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = window.unpromptedLanguage?.text('copy.fallback') || 'Commands selected. Use your browser’s Copy command.';
  }
});

// ScrollTo moves only after an explicit navigation click. Ordinary wheel and
// touch scrolling stay native, and an interrupted navigation tween auto-kills.
if (window.gsap && window.ScrollToPlugin) {
  gsap.registerPlugin(ScrollToPlugin);
  document.documentElement.classList.add('gsap-navigation');
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.hash.slice(1));
    if (!target) return;
    event.preventDefault();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const complete = () => {
      history.replaceState(null, '', link.hash);
      const focusTarget = target.querySelector('h1,h2') || target;
      if (!focusTarget.hasAttribute('tabindex')) focusTarget.setAttribute('tabindex', '-1');
      focusTarget.focus({ preventScroll: true });
    };
    if (window.unpromptedExperience.lenis) {
      window.unpromptedExperience.lenis.scrollTo(target, { offset: -28, duration: .95, onComplete: complete });
      return;
    }
    gsap.to(window, {
      duration: reduced ? 0 : .95,
      scrollTo: { y: target, offsetY: 28, autoKill: true },
      ease: 'power2.inOut', overwrite: 'auto',
      onComplete: complete
    });
  });
}
