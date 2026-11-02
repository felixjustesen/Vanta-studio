// Skarps hero: filmen (pause og blødt loop), mobilmenuen og det store ord, der glider med musen.
const video = document.querySelector(".film video");
const pause = document.querySelector(".pause");
const film = document.querySelector(".film");
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- Filmen ----------
function setPaused(paused) {
  pause.setAttribute("aria-pressed", paused ? "true" : "false");
  pause.setAttribute("aria-label", paused ? "Afspil filmen" : "Sæt filmen på pause");
}
pause.addEventListener("click", () => {
  if (video.paused) { video.play(); setPaused(false); } else { video.pause(); setPaused(true); }
});
// Blødt loop: ud til posteren lige før slutningen, forfra og ind igen
let dipping = false;
video.addEventListener("timeupdate", () => {
  if (!dipping && video.duration && video.duration - video.currentTime < 0.75) {
    dipping = true;
    film.classList.add("dip");
  }
});
video.addEventListener("ended", () => {
  video.currentTime = 0;
  if (pause.getAttribute("aria-pressed") !== "true") video.play();
  film.classList.remove("dip");
  dipping = false;
});
// Ved reduceret bevægelse står filmen stille, indtil man selv trykker afspil
if (reduce) setPaused(true);
else video.play()?.catch(() => setPaused(true));

// ---------- Mobilmenu ----------
const burger = document.querySelector(".burger");
const sheet = document.getElementById("sheet");
function menu(open) {
  sheet.classList.toggle("open", open);
  burger.setAttribute("aria-expanded", open ? "true" : "false");
  burger.setAttribute("aria-label", open ? "Luk menu" : "Åbn menu");
}
burger.addEventListener("click", () => menu(!sheet.classList.contains("open")));
sheet.addEventListener("click", (e) => { if (e.target.closest("a")) menu(false); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sheet.classList.contains("open")) {
    menu(false);
    burger.focus();
  }
});

// ---------- Det store ord glider let med musen ----------
if (!reduce && matchMedia("(hover: hover)").matches) {
  const giant = document.querySelector(".giant");
  let target = 0;
  let x = 0;
  let raf = 0;
  const tick = () => {
    x += (target - x) * 0.06;
    giant.style.setProperty("--px", `${x.toFixed(1)}px`);
    raf = Math.abs(target - x) > 0.2 ? requestAnimationFrame(tick) : 0;
  };
  window.addEventListener("pointermove", (e) => {
    target = (e.clientX / window.innerWidth - 0.5) * -60;
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: true });
}

// ---------- Demobjælken ----------
// Heroen gøres lige så meget lavere, som bjælken fylder, så bunden af heroen altid ses
const bar = document.getElementById("demo-bar");
if (bar) {
  const fit = () => document.documentElement.style.setProperty("--bar-h", `${bar.hidden ? 0 : bar.offsetHeight}px`);
  new ResizeObserver(fit).observe(bar);
  new MutationObserver(fit).observe(bar, { attributes: true, attributeFilter: ["hidden"] });
}
