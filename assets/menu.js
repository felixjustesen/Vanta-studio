// Vanta Studio – hamburgermenu (bruges på alle sider)
(function () {
  var menu = document.getElementById("vm");
  if (!menu) return;
  var openers = document.querySelectorAll("[data-vm-open]");
  var closeBtn = menu.querySelector(".vm-close");
  var lastOpener = null;

  function focusables() {
    return Array.prototype.filter.call(
      menu.querySelectorAll("a[href], button:not([disabled])"),
      function (el) { return el.offsetParent !== null; }
    );
  }

  function open(opener) {
    lastOpener = opener || null;
    // Én frame, så overgangen kører fra den lukkede tilstand
    requestAnimationFrame(function () {
      menu.classList.add("open");
      document.documentElement.classList.add("vm-lock");
      openers.forEach(function (b) { b.setAttribute("aria-expanded", "true"); });
      closeBtn.focus();
    });
  }

  function close() {
    if (!menu.classList.contains("open")) return;
    menu.classList.remove("open");
    document.documentElement.classList.remove("vm-lock");
    openers.forEach(function (b) { b.setAttribute("aria-expanded", "false"); });
    if (lastOpener) lastOpener.focus();
  }

  openers.forEach(function (b) {
    b.addEventListener("click", function () { open(b); });
  });
  closeBtn.addEventListener("click", close);

  document.addEventListener("keydown", function (e) {
    if (!menu.classList.contains("open")) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    // Hold fokus inde i menuen
    if (e.key === "Tab") {
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // Undermenuer
  menu.querySelectorAll(".vm-toggle").forEach(function (t) {
    t.addEventListener("click", function () {
      var sub = document.getElementById(t.getAttribute("aria-controls"));
      var on = t.getAttribute("aria-expanded") !== "true";
      t.setAttribute("aria-expanded", String(on));
      sub.classList.toggle("open", on);
      sub.querySelectorAll("a").forEach(function (a) { a.tabIndex = on ? 0 : -1; });
    });
  });
  menu.querySelectorAll(".vm-sub:not(.open) a").forEach(function (a) { a.tabIndex = -1; });

  // Ankerlinks til samme side lukker menuen
  menu.addEventListener("click", function (e) {
    var a = e.target.closest("a");
    if (a && a.hash && a.pathname === location.pathname) close();
  });
})();

// Undersider: header bliver mørk ved scroll, og elementer glider ind
(function () {
  var hdr = document.querySelector(".sp-hdr");
  if (hdr) {
    var onScroll = function () { hdr.classList.toggle("solid", window.scrollY > 30); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  if (!document.body.classList.contains("sp")) return;
  var items = document.querySelectorAll(".rv");
  if (!items.length || !("IntersectionObserver" in window)) {
    items.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
    });
  }, { rootMargin: "0px 0px -8% 0px" });
  items.forEach(function (el) { io.observe(el); });
})();
