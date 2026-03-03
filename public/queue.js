(function ($) {
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function fmtTime(ts) {
    const d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtRemaining(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    if (h > 0) return h + ':' + pad2(m) + ':' + pad2(s);
    return m + ':' + pad2(s);
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  function initPowerProgress($box) {
    const mode = ($box.data('mode') || '').toString(); // on/off
    const from = parseInt($box.data('from'), 10);
    const to = parseInt($box.data('to'), 10);
    const label = ($box.data('label') || '').toString();

    if (!from || !to || to <= from) return;

    const $fill = $('#ppFill');
    const $rem = $('#ppRemaining');
    const $left = $('#ppLeft');
    const $right = $('#ppRight');
    const $title = $('#ppTitle');

    $title.text(label || (mode === 'off' ? 'Триває відключення' : 'Світло є'));
    if (mode === 'off') {
      $left.html('Початок: <b>' + fmtTime(from) + '</b>');
      $right.html('Увімкнення: <b>' + fmtTime(to) + '</b>');
    } else {
      $left.text('Зараз: —');
      $right.html('Відключення: <b>' + fmtTime(to) + '</b>');
    }

    function tick() {
      const now = Math.floor(Date.now() / 1000);
      if (mode !== 'off') {
        $left.html('Зараз: <b>' + fmtTime(now) + '</b>');
      }

      if (now >= to) {
        $fill.css('width', '100%');
        $rem.text('0:00');
        return;
      }

      if (now <= from) {
        $fill.css('width', '0%');
        $rem.text(fmtRemaining(to - now));
        return;
      }

      const total = to - from;
      const passed = now - from;
      const pct = clamp((passed / total) * 100, 0, 100);

      $fill.css('width', pct.toFixed(2) + '%');
      $rem.text(fmtRemaining(to - now));

      if (mode !== 'off') {
        $left.html('Зараз: <b>' + fmtTime(now) + '</b>');
      }
    }

    tick();
    setInterval(tick, 1000);
  }

  function showTab(tab) {
    const isToday = tab === 'today';
    $('#todayPane').toggle(isToday);
    $('#today').toggleClass('is-active', isToday);
  }

  $(function () {
    $(document).on('click', '.downloadScreen', function (e) {
      e.preventDefault();
      const type = $(this).data('type');
      window.location.href = '/image/all/' + type + '/render/' + Math.floor(Date.now() / 1000);
    });

    const $pp = $('#powerProgress');
    if ($pp.length) initPowerProgress($pp);

    $('#today').on('click', function () {
      showTab('today');
    });
    showTab('today');
  });
})(jQuery);
