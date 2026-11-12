/* Smooth movement between ideas; a measured pause for each actual result.
   Mobile and reduced-motion visitors keep the same manual component controls. */
(() => {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  const api = window.unpromptedExperience;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = matchMedia('(min-width:1024px) and (min-height:700px)');
  let lenis, ticker, context, stageTrigger;
  const keys = ['notice', 'prepare', 'verify'];
  function stopSmoothing() {
    if (ticker) gsap.ticker.remove(ticker);
    lenis?.destroy();
    lenis = api.lenis = undefined;
  }
  function setup() {
    context?.revert();
    stopSmoothing();
    stageTrigger = null;
    document.querySelector('.workflow').classList.remove('is-pinned');
    if (reduced.matches) {
      ScrollTrigger.refresh();
      return;
    }
    if (window.Lenis) {
      lenis = api.lenis = new Lenis({ lerp: .1, smoothWheel: true, syncTouch: false });
      lenis.on('scroll', ScrollTrigger.update);
      ticker = time => lenis.raf(time * 1000);
      gsap.ticker.add(ticker);
      gsap.ticker.lagSmoothing(0);
    }
    context = gsap.context(() => {
      gsap.from('.diagram-caption > div', {
        opacity: .35, y: 8, duration: .6, stagger: .12,
        scrollTrigger: { trigger: '.diagram-caption', start: 'top 90%', once: true }
      });
      if (desktop.matches) {
        api.showResult('notice');
        const section = document.querySelector('.workflow');
        section.classList.add('is-pinned');
        stageTrigger = ScrollTrigger.create({
          id: 'result-showcase', trigger: section, start: 'top top',
          end: () => `+=${Math.max(innerHeight * 1.65, 1200)}`,
          pin: true, anticipatePin: 1, invalidateOnRefresh: true,
          onUpdate: self => api.showResult(keys[Math.min(2, Math.floor(self.progress * 3))]),
          snap: {
            snapTo: [0, .5, 1], delay: .3, duration: { min: .2, max: .65 },
            ease: 'power2.inOut', inertia: false
          }
        });
      }
    });
    requestAnimationFrame(() => { lenis?.resize(); ScrollTrigger.refresh(); });
  }
  api.goToResult = key => {
    if (!stageTrigger) return false;
    const index = keys.indexOf(key);
    const target = stageTrigger.start + (stageTrigger.end - stageTrigger.start) * index / 2;
    if (lenis) lenis.scrollTo(target, { duration: .95 });
    else gsap.to(window, { scrollTo: { y: target, autoKill: true }, duration: .95, ease: 'power2.inOut' });
    return true;
  };
  reduced.addEventListener('change', setup);
  desktop.addEventListener('change', setup);
  window.addEventListener('load', setup, { once: true });
  window.addEventListener('pagehide', () => { context?.revert(); stopSmoothing(); });
  window.addEventListener('pageshow', event => { if (event.persisted) setup(); });
})();
