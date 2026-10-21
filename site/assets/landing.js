// The live-query demo: two simulated clients subscribed to the same query.
(() => {
  const demo = document.querySelector("[data-demo]");
  if (!demo) return;
  const lists = [...demo.querySelectorAll("[data-list]")];
  const log = demo.querySelector("[data-log]");
  const messages = [];
  let userTouched = false;

  const render = (freshIndex) => {
    for (const list of lists) {
      list.replaceChildren(
        ...messages.slice(-5).map((m, i, shown) => {
          const li = document.createElement("li");
          const b = document.createElement("b");
          b.textContent = m.author;
          li.append(b, document.createTextNode(m.body));
          if (messages.length - shown.length + i === freshIndex) li.classList.add("fresh");
          return li;
        }),
      );
    }
  };

  const send = (author, body) => {
    messages.push({ author, body });
    // The simulated server commits, re-runs the one affected query and pushes to both clients.
    setTimeout(() => {
      render(messages.length - 1);
      log.innerHTML = `<span class="ok">✓</span> mutation <b>messages:send</b> committed → 1 query re-ran → pushed to 2 clients`;
    }, 80);
  };

  demo.querySelectorAll("[data-form]").forEach((form) => {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      userTouched = true;
      const input = form.querySelector("input");
      const body = input.value.trim();
      if (!body) return;
      send(form.dataset.author, body);
      input.value = "";
    });
  });

  // A short scripted conversation until the visitor tries it themselves.
  const script = [
    ["Alice", "shipped the new schema 🚀"],
    ["Bob", "seeing it already, no refresh"],
    ["Alice", "one binary, 33 MB of RAM"],
    ["Bob", "type something in either window →"],
  ];
  let step = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced) {
    script.forEach(([a, b]) => messages.push({ author: a, body: b }));
    render(-1);
    return;
  }
  const tick = () => {
    if (userTouched || step >= script.length) return;
    send(...script[step++]);
    setTimeout(tick, 2200);
  };
  // Start once the demo scrolls into view (a scroll check backs up IntersectionObserver).
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    observer?.disconnect();
    removeEventListener("scroll", onScroll);
    setTimeout(tick, 400);
  };
  const inView = () => {
    const r = demo.getBoundingClientRect();
    return r.top < innerHeight * 0.85 && r.bottom > 0;
  };
  const onScroll = () => inView() && start();
  const observer = "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && start())
    : null;
  observer?.observe(demo);
  addEventListener("scroll", onScroll, { passive: true });
  if (inView()) start();
})();
