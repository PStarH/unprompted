/* One language control for the whole landing page. No saved preference or
   third-party browser request; repository statistics are a same-origin file. */
(() => {
  const copy = window.unpromptedCopy;
  let language = 'en';
  let repositoryStats;
  const text = key => copy.strings[language][key] || copy.strings.en[key] || key;
  function updateGitHub() {
    const button = document.querySelector('.github-button');
    const stars = repositoryStats?.stars ?? 0;
    const formatted = new Intl.NumberFormat(language === 'zh' ? 'zh-CN' : 'en', { notation: 'compact', maximumFractionDigits: 1 }).format(stars);
    document.querySelector('#github-stars').textContent = formatted;
    button.setAttribute('aria-label', language === 'zh' ? `在 GitHub 查看 Unprompted，${stars} 个 Star` : `Unprompted on GitHub, ${stars} stars`);
    if (repositoryStats?.updatedAt) button.title = `${stars} stars · ${new Date(repositoryStats.updatedAt).toLocaleDateString(language === 'zh' ? 'zh-CN' : 'en-US')}`;
  }
  function setLanguage(next) {
    if (!copy.strings[next]) return;
    language = next;
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.title = text('title');
    document.querySelectorAll('[data-copy]').forEach(el => { el.innerHTML = text(el.dataset.copy); });
    document.querySelectorAll('[data-language]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.language === language)));
    window.unpromptedComponents.setLanguage(language);
    const selected = document.querySelector('[data-step][aria-selected=true]')?.dataset.step || 'notice';
    const scenario = document.querySelector('[data-scenario][aria-selected=true]')?.dataset.scenario || 'followup';
    window.unpromptedExperience.showResult(selected);
    window.unpromptedExperience.showScenario(scenario);
    const connector = document.querySelector('[data-connector][aria-pressed=true]')?.dataset.connector || 'gmail';
    document.querySelector('#connector-description').textContent = copy.dynamic[language].connectors[connector];
    document.querySelectorAll('[data-scenario]').forEach((button, i) => {
      button.dataset.shortLabel = copy.dynamic[language].shortLabels[i];
      button.setAttribute('aria-label', button.querySelector('span').textContent);
    });
    const motion = document.querySelector('#motion-toggle');
    motion.textContent = text(motion.getAttribute('aria-pressed') === 'true' ? 'motion.resume' : 'motion.pause');
    document.querySelector('.menu-toggle').setAttribute('aria-label', text('menu.open'));
    document.querySelector('#copy-command').setAttribute('aria-label', language === 'zh' ? '复制安装和启动命令' : 'Copy installation and startup commands');
    document.querySelector('.loom-stage img').alt = language === 'zh' ? '示意图：多个授权来源的信息汇入织机，整理成一个可用结果。' : 'Diagram: information from authorized sources becomes one prepared result.';
    document.querySelector('.focus-map').setAttribute('aria-label', language === 'zh' ? '后台信息汇聚到一个需要你判断的事项。' : 'Background work narrows to one decision that needs you.');
    updateGitHub();
    requestAnimationFrame(() => {
      window.unpromptedExperience.lenis?.resize();
      window.ScrollTrigger?.refresh();
      window.dispatchEvent(new Event('unprompted:language'));
    });
  }
  window.unpromptedLanguage = { setLanguage, text, get language() { return language; }, get dynamic() { return copy.dynamic[language]; } };
  document.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => setLanguage(button.dataset.language)));
  setLanguage('en');
  fetch('repo-stats.json').then(response => {
    if (!response.ok) throw new Error('Repository statistics unavailable');
    return response.json();
  }).then(stats => {
    if (Number.isSafeInteger(stats.stars) && stats.stars >= 0) { repositoryStats = stats; updateGitHub(); }
  }).catch(() => { /* The pre-rendered count remains the verified initial snapshot. */ });
})();
