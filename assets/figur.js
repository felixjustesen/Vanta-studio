// Figuren fra forsidens bund: en video, der spoles frem og tilbage med musen,
// og hvor kun den røde baggrund farves over i Vantas violet.
// Bruges på forsiden (#kontakt) og som baggrund på /kontakt.
//   vantaFigur(scene, video, canvas, { position: 0.7 })
// scene: elementet, der får klassen "recolor", når den omfarvede version er klar.
(function () {
  var SENSITIVITY = 0.8;
  var HUE = -92 * Math.PI / 180;           // rød (~350°) -> violet (~258°)
  var cH = Math.cos(HUE), sH = Math.sin(HUE);
  // Lysstyrkebevarende hue-rotationsmatrix
  var M = [
    0.213 + cH * 0.787 - sH * 0.213, 0.715 - cH * 0.715 - sH * 0.715, 0.072 - cH * 0.072 + sH * 0.928,
    0.213 - cH * 0.213 + sH * 0.143, 0.715 + cH * 0.285 + sH * 0.140, 0.072 - cH * 0.072 - sH * 0.283,
    0.213 - cH * 0.213 - sH * 0.787, 0.715 - cH * 0.715 + sH * 0.715, 0.072 + cH * 0.928 + sH * 0.072
  ];
  var ss = function (a, b, x) { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };

  window.vantaFigur = function (scene, video, cv, opts) {
    var pos = (opts && opts.position) != null ? opts.position : 0.7;

    // Videoen afspilles ikke – den spoles frem og tilbage, når musen bevæger sig vandret
    var prevX = null, targetTime = 0, seeking = false;
    function seek() {
      if (!video.duration) return;
      seeking = true;
      video.currentTime = targetTime;
    }
    video.addEventListener("seeked", function () {
      seeking = false;
      if (Math.abs(video.currentTime - targetTime) > 0.01) seek();
    });
    function move(x) {
      if (prevX === null) { prevX = x; return; }
      var delta = x - prevX;
      prevX = x;
      if (!video.duration) return;
      var r = scene.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return;
      targetTime = Math.min(video.duration, Math.max(0, targetTime + (delta / window.innerWidth) * SENSITIVITY * video.duration));
      if (!seeking) seek();
    }
    window.addEventListener("mousemove", function (e) { move(e.clientX); }, { passive: true });
    window.addEventListener("touchmove", function (e) { if (e.touches[0]) move(e.touches[0].clientX); }, { passive: true });
    window.addEventListener("touchend", function () { prevX = null; });

    // ---------- Omfarvning: kun den røde baggrund drejes over i Vantas violet ----------
    // Figurens hud, hår og trøje har lavere mætning eller en anden nuance og bliver ikke rørt.
    var cx = cv.getContext("2d", { willReadFrequently: true });
    function paint() {
      if (!video.videoWidth) return;
      var W = cv.clientWidth, H = cv.clientHeight;
      var scale = Math.min(1, 1400 / W);
      var cw = Math.round(W * scale), ch = Math.round(H * scale);
      if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
      // Samme beskæring som object-fit: cover; object-position: <pos> center
      var vr = video.videoWidth / video.videoHeight, k = cw / ch > vr ? cw / video.videoWidth : ch / video.videoHeight;
      var dw = video.videoWidth * k, dh = video.videoHeight * k;
      cx.drawImage(video, (cw - dw) * pos, (ch - dh) / 2, dw, dh);
      var img;
      try { img = cx.getImageData(0, 0, cw, ch); } catch (e) { return; } // CORS: vis originalen
      var d = img.data;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        var mx = r > g ? (r > b ? r : b) : (g > b ? g : b), mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        if (mx < 20 || r !== mx) continue;
        var sat = (mx - mn) / mx;
        // nuance: hvor tæt på ren rød (g og b lave i forhold til hinanden)
        var hueOff = (g - b) / (mx - mn + 1);         // 0 = rød/magenta, 1 = orange
        // Baggrunden: meget mættet, ren rød og ikke mørk. Hår og bryn er mere orange (hueOff > 0.1) eller mørkere.
        var w = ss(0.6, 0.8, sat) * (1 - ss(0.03, 0.09, hueOff)) * ss(70, 115, mx);
        if (w <= 0) continue;
        var nr = M[0] * r + M[1] * g + M[2] * b, ng = M[3] * r + M[4] * g + M[5] * b, nb = M[6] * r + M[7] * g + M[8] * b;
        d[i] = r + (nr - r) * w; d[i + 1] = g + (ng - g) * w; d[i + 2] = b + (nb - b) * w;
      }
      cx.putImageData(img, 0, 0);
      scene.classList.add("recolor");
    }
    video.addEventListener("seeked", paint);
    video.addEventListener("loadeddata", function () { paint(); });
    window.addEventListener("resize", paint);
    if (video.readyState >= 2) paint();
  };
})();
