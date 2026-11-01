/* One continuous, load-bearing silk line. Every stop is a real DOM attachment:
   sources are woven into context, evidence is gathered, a review task is handed
   over. There are no floating waypoints or oscillating horizontal coordinates. */
(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const spider = $('#spider');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const motionButton = $('#motion-toggle');
  const svgNS = 'http://www.w3.org/2000/svg';
  const mix = (a, b, t) => a + (b - a) * t;
  const clamp = t => Math.max(0, Math.min(1, t));
  let context, tween, resizeTimer, paused = false;

  function rect(selector) {
    const r = (typeof selector === 'string' ? $(selector) : selector).getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top + scrollY, bottom: r.bottom + scrollY, width: r.width, height: r.height, x: r.left + r.width / 2, y: r.top + scrollY + r.height / 2 };
  }
  function node(tag, attributes) {
    const el = document.createElementNS(svgNS, tag);
    for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
    return el;
  }
  function drawHero() {
    const world = rect('.hero-world');
    const hub = rect('.hero-anchor');
    const mail = rect('.note-mail');
    const doc = rect('.note-doc');
    const local = p => `${(p.x - world.left).toFixed(1)},${(p.y - world.top).toFixed(1)}`;
    const points = [
      { x: hub.x, y: world.top + 1 },
      ...(mail.width ? [{ x: mail.right, y: mail.y }] : []),
      ...(doc.width ? [{ x: doc.left, y: doc.y }] : []),
      { x: world.right - 1, y: hub.y }
    ];
    $('.hero-threads').replaceChildren(...points.flatMap(p => [
      node('path', { d: `M${local(p)} L${local(hub)}` }),
      node('circle', { cx: p.x - world.left, cy: p.y - world.top, r: 3 })
    ]));
  }
  function drawConnections(railX) {
    const field = rect('.connector-field');
    const hub = { x: railX - field.left, y: 31 };
    const cards = $$('.connector').map(el => rect(el));
    const paths = cards.map(card => {
      const x = card.x - field.left, y = card.top - field.top;
      return `M${hub.x},${hub.y} Q${x},${hub.y + 8} ${x},${y}`;
    });
    // Cross silk follows the actual radial strands, giving the connections a
    // shared web structure rather than six independent diagram wires.
    const mesh = [.44, .73].map(t => cards.map((card, i) => {
      const endX = card.x - field.left, endY = card.top - field.top;
      const x = (1 - t) ** 2 * hub.x + (2 * (1 - t) * t + t * t) * endX;
      const y = (1 - t) ** 2 * hub.y + 2 * (1 - t) * t * (hub.y + 8) + t * t * endY;
      return `${i ? 'L' : 'M'}${x},${y}`;
    }).join(' '));
    $('.connector-foundation').replaceChildren(...[...paths, ...mesh].map(d => node('path', { d })));
    $('.cross-threads').replaceChildren(...[...paths, ...mesh].map(d => node('path', { d, class: 'woven-thread' })));
    $('.connector-knots').replaceChildren(
      node('circle', { cx: hub.x, cy: hub.y, r: 5, class: 'web-hub' }),
      ...cards.map(card => node('circle', { cx: card.x - field.left, cy: card.top - field.top, r: 3 }))
    );
    return $$('.woven-thread').map(path => ({ path, length: path.getTotalLength() }));
  }

  function setup() {
    context?.revert();
    tween?.kill();
    document.body.classList.toggle('motion-paused', paused);
    const mobile = innerWidth < 768;
    const frame = rect('.page-frame');
    const railX = frame.right - (mobile ? 25 : 56);
    drawHero();
    let threads = drawConnections(railX);
    if (reduced.matches || paused) {
      $$('.connector').forEach(el => el.classList.remove('is-woven'));
      $('.example-result').classList.remove('is-delivered');
      return;
    }
    if (!window.gsap || !window.ScrollTrigger) {
      const hero = rect('.hero-anchor');
      spider.style.transform = `translate(${hero.x - spider.offsetWidth / 2}px,${hero.y - spider.offsetHeight / 2}px)`;
      return;
    }
    gsap.registerPlugin(ScrollTrigger);
    context = gsap.context(() => {
      const width = spider.offsetWidth, height = width * 344 / 424;
      const scale = mobile ? .42 : .48;
      let stops, pathLength, turnLength, sourceStart, sourceEnd, evidenceEnd, deliveryStart, deliveryEnd;
      let figureTop, figureBottom, figureRight, pinStart = 0, pinDistance = 0;
      const playhead = { scroll: 0 };
      function measure() {
        drawHero();
        threads = drawConnections(railX);
        const hero = rect('.hero-anchor');
        const heroSection = rect('.hero');
        const field = rect('.connector-field');
        const loom = rect('.loom-stage');
        const figure = rect('.product-figure');
        const attention = rect('.attention-crop');
        const stage = ScrollTrigger.getById('result-showcase');
        pinStart = stage?.start || 0;
        pinDistance = stage ? stage.end - stage.start : 0;
        if (stage) {
          const offset = figure.top - rect('.workflow').top;
          figure.top = stage.start + offset;
          figure.bottom = figure.top + figure.height;
        }
        figureTop = figure.top; figureBottom = figure.bottom; figureRight = figure.right;
        const scenario = rect('.scenario-panel');
        const result = rect('.example-result');
        const boundary = rect('.boundaries');
        const terminal = rect('.start-terminal');
        const at = (x, y, scroll, size = scale) => ({ x, y, scroll, scale: size });
        const visible = y => y - innerHeight * .46;
        sourceStart = field.top - innerHeight * .58;
        sourceEnd = field.bottom - innerHeight * .4;
        evidenceEnd = stage ? stage.end : visible(figure.bottom - 35);
        deliveryStart = visible(scenario.top - 25);
        deliveryEnd = visible(result.top + 15);
        stops = [
          at(hero.x, hero.y, 0, 1),
          at(railX, heroSection.bottom - 65, visible(heroSection.bottom - 65)),
          at(railX, field.top + 31, sourceStart),
          at(railX, field.top + 31, sourceEnd), // Hold at the hub while weaving.
          at(railX, loom.top + 50, visible(loom.top + 50)),
          at(railX, loom.bottom - 30, visible(loom.bottom - 30)),
          at(railX, figure.top - 26, stage ? stage.start : visible(figure.top - 26)),
          at(railX, figure.bottom + pinDistance - 35, evidenceEnd), // Climb the evidence frame.
          at(railX, attention.top - 20, visible(attention.top - 20)),
          at(railX, attention.bottom - 20, visible(attention.bottom - 20)),
          at(railX, scenario.top - 25, deliveryStart),
          at(railX, result.top + 15, deliveryEnd), // Hand off at the review frame.
          at(railX, boundary.top + 80, visible(boundary.top + 80)),
          at(railX, terminal.top - 25, visible(terminal.top - 25))
        ];
        stops.forEach((p, i) => { p.scroll = Math.max(i ? stops[i - 1].scroll + 1 : 0, p.scroll); });
        // The background is the actual travel surface, with visible knots at
        // the DOM corners rather than a decorative line following the mascot.
        const turn = `M${hero.x},${hero.y} C${hero.x},${heroSection.bottom - 115} ${railX},${heroSection.bottom - 115} ${railX},${heroSection.bottom - 65}`;
        turnLength = node('path', { d: turn }).getTotalLength();
        const track = `${turn} L${railX},${terminal.top - 25}`;
        $('#rail-track').setAttribute('d', track);
        $('#journey-thread').setAttribute('d', track);
        pathLength = $('#journey-thread').getTotalLength();
        const pegs = [
          { x: railX, y: field.top + 31 },
          { x: railX, y: figure.top }, { x: railX, y: figure.bottom + pinDistance },
          { x: railX, y: result.top }, { x: railX, y: terminal.top }
        ];
        $('#silk-pegs').replaceChildren(...pegs.map(p => node('circle', { cx: p.x, cy: p.y, r: mobile ? 3 : 4 })));
        $('#silk-attachments').replaceChildren(...[
          { x: figure.right, y: figure.top }, { x: figure.right, y: figure.bottom },
          { x: scenario.right, y: result.top }, { x: terminal.right, y: terminal.top }
        ].map(p => node('path', { d: `M${railX},${p.y} L${p.x},${p.y}` })));
        $('.story-layer').style.height = `${document.documentElement.scrollHeight}px`;
      }
      function render(scroll) {
        let i = stops.findIndex((p, index) => index < stops.length - 1 && scroll < stops[index + 1].scroll);
        if (i < 0) i = stops.length - 2;
        const a = stops[i], b = stops[i + 1];
        const progress = clamp((scroll - a.scroll) / (b.scroll - a.scroll));
        // A single, visible turn out of Hero. Every later move follows the
        // same vertical silk axis; no sinusoidal wobble or side-to-side jumps.
        const t = i === 0 ? progress * progress * (3 - 2 * progress) : progress;
        const turnPoint = i === 0 ? $('#rail-track').getPointAtLength(turnLength * t) : null;
        const x = turnPoint ? turnPoint.x : mix(a.x, b.x, t);
        const y = turnPoint ? turnPoint.y : mix(a.y, b.y, t);
        const size = mix(a.scale, b.scale, t);
        gsap.set(spider, { x: x - width / 2, y: y - height / 2, scale: size, rotation: 0, transformOrigin: '50% 50%' });
        const carrying = clamp((scroll - evidenceEnd + 70) / 100) * (1 - clamp((scroll - deliveryEnd + 60) / 60));
        gsap.set($('.carried-task'), { opacity: carrying, y: carrying * 2 });
        const woven = clamp((scroll - sourceStart) / (sourceEnd - sourceStart));
        threads.forEach(({ path, length }, index) => {
          const amount = index < 6 ? clamp((woven - index * .06) / .5) : clamp((woven - .5 - (index - 6) * .05) / .45);
          path.style.strokeDasharray = `${length}`;
          path.style.strokeDashoffset = `${length * (1 - amount)}`;
          if (index < 6) $$('.connector')[index].classList.toggle('is-woven', amount > .95);
        });
        $('.connections').classList.toggle('context-woven', woven > .95);
        $('.product-figure').classList.toggle('evidence-gathered', scroll >= evidenceEnd - 30);
        $('.example-result').classList.toggle('is-delivered', scroll >= deliveryEnd - 15);
        if (pinDistance) {
          const offset = Math.max(0, Math.min(pinDistance, scroll - pinStart));
          const pegs = $('#silk-pegs').children;
          pegs[1].setAttribute('cy', figureTop + offset);
          pegs[2].setAttribute('cy', figureBottom + offset);
          const ties = $('#silk-attachments').children;
          ties[0].setAttribute('d', `M${railX},${figureTop + offset} L${figureRight},${figureTop + offset}`);
          ties[1].setAttribute('d', `M${railX},${figureBottom + offset} L${figureRight},${figureBottom + offset}`);
        }
        const travelled = i === 0 ? turnLength * t : turnLength + y - stops[1].y;
        $('#journey-thread').style.strokeDasharray = `${pathLength}`;
        $('#journey-thread').style.strokeDashoffset = `${pathLength - travelled}`;
        // A fixed ceiling anchor holds the Hero suspension. Once on the rail,
        // the rail itself is the support; an invented moving anchor is absent.
        $('#hanging-thread').setAttribute('d', i === 0 ? `M${stops[0].x},${rect('.hero-world').top} L${x},${y - height * size * .27}` : '');
        spider.dataset.scene = scroll < sourceStart ? 'arrive' : scroll < sourceEnd ? 'weave' : scroll < evidenceEnd ? 'gather' : scroll < deliveryEnd ? 'carry' : 'delivered';
      }
      measure();
      render(scrollY);
      tween = gsap.fromTo(playhead, { scroll: 0 }, {
        scroll: () => ScrollTrigger.maxScroll(window), ease: 'none',
        onUpdate: () => render(playhead.scroll),
        scrollTrigger: {
          trigger: document.body, start: 0, end: 'max', scrub: .45,
          invalidateOnRefresh: true,
          onRefresh: () => { measure(); render(playhead.scroll); }
        }
      });
    });
  }
  motionButton?.addEventListener('click', () => {
    paused = !paused;
    motionButton.setAttribute('aria-pressed', String(paused));
    motionButton.textContent = window.unpromptedLanguage?.text(paused ? 'motion.resume' : 'motion.pause') || (paused ? 'Resume animation' : 'Pause animation');
    setup();
  });
  reduced.addEventListener('change', setup);
  window.addEventListener('unprompted:language', setup);
  window.addEventListener('load', setup, { once: true });
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setup, 180);
  });
  window.addEventListener('pagehide', () => { context?.revert(); tween?.kill(); });
  window.addEventListener('pageshow', event => { if (event.persisted) setup(); });
})();
