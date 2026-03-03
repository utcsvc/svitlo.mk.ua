(function ($) {
  const ALL_STREET = 'Всі вулиці';
  const ALL_NUM = 'Усі будинки';

  function setTab(tab) {
    const isQueue = tab === 'queue';
    $('#tab-queue').toggleClass('is-active', isQueue);
    $('#tab-address').toggleClass('is-active', !isQueue);
    $('#pane-queue').toggle(isQueue);
    $('#pane-address').toggle(!isQueue);
  }

  function lockField($field) {
    $field.prop('disabled', true);
    $field.closest('.field').addClass('is-locked');
  }

  function unlockField($field) {
    $field.prop('disabled', false);
    $field.closest('.field').removeClass('is-locked');
  }

  function destroyAutocomplete($input) {
    if ($input.data('ui-autocomplete')) {
      $input.autocomplete('destroy');
    }
  }

  function setAutocompleteWidth() {
    const $input = $(this);
    const $menu = $input.autocomplete('widget');
    $menu.css({
      width: $input.outerWidth() + 'px',
      zIndex: 99999
    });
  }

  $(function () {
    $('#tab-queue').on('click', () => setTab('queue'));
    $('#tab-address').on('click', () => setTab('address'));
    setTab('queue');

    const $city = $('#city');
    const $street = $('#street');
    const $num = $('#num');
    const $btn = $('#start_search');

    let streetsPrefetch = [];
    let numsPrefetch = [];

    lockField($street);
    lockField($num);
    $btn.prop('disabled', true);

    $city.autocomplete({
      minLength: 0,
      delay: 250,
      autoFocus: true,
      open: setAutocompleteWidth,
      source: function (request, response) {
        const term = (request.term || '').trim();
        $.getJSON('/ajax/get_cities', { term })
          .done((data) => response((data || []).map((v) => ({ label: v, value: v }))))
          .fail(() => response([]));
      },
      select: function (event, ui) {
        const city = ui.item.value;
        $city.val(city);

        streetsPrefetch = [];
        numsPrefetch = [];

        unlockField($street);
        $street.val('');
        destroyAutocomplete($street);

        lockField($num);
        $num.val('');
        destroyAutocomplete($num);

        $btn.prop('disabled', true);

        prefetchStreets(city);
        return false;
      }
    });

    $city.on('input', function () {
      streetsPrefetch = [];
      numsPrefetch = [];
      unlockField($street);
      $street.val('');
      destroyAutocomplete($street);
      lockField($num);
      $num.val('');
      destroyAutocomplete($num);
      $btn.prop('disabled', true);
    });

    function setAllAndLockStreetNum() {
      $street.val(ALL_STREET);
      lockField($street);
      destroyAutocomplete($street);

      $num.val(ALL_NUM);
      lockField($num);
      destroyAutocomplete($num);

      $btn.prop('disabled', false);
    }

    function prefetchStreets(city) {
      $.getJSON('/ajax/get_streets', { city, term: '' })
        .done(function (streets) {
          streetsPrefetch = (streets || []).slice(0, 50);
          if (streetsPrefetch.length === 0) {
            setAllAndLockStreetNum();
            return;
          }

          unlockField($street);
          $street.val('');
          initStreets(city);

          lockField($num);
          $num.val('');
          destroyAutocomplete($num);
          $btn.prop('disabled', true);
        })
        .fail(setAllAndLockStreetNum);
    }

    function initStreets(city) {
      destroyAutocomplete($street);
      $street.autocomplete({
        minLength: 0,
        delay: 250,
        autoFocus: true,
        open: setAutocompleteWidth,
        source: function (request, response) {
          const term = (request.term || '').trim();
          if (term.length < 3) {
            response(streetsPrefetch.map((v) => ({ label: v, value: v })));
            return;
          }
          $.getJSON('/ajax/get_streets', { city, term })
            .done((data) => response((data || []).map((v) => ({ label: v, value: v }))))
            .fail(() => response(streetsPrefetch.map((v) => ({ label: v, value: v }))));
        },
        select: function (event, ui) {
          const street = ui.item.value;
          $street.val(street);

          numsPrefetch = [];
          lockField($num);
          $num.val('');
          destroyAutocomplete($num);
          $btn.prop('disabled', true);
          prefetchNums(city, street);
          return false;
        }
      });

      $street.off('focus.prefetch').on('focus.prefetch', function () {
        if (!$street.prop('disabled')) $(this).autocomplete('search', $(this).val());
      });

      $street.off('input.autocomplete').on('input.autocomplete', function () {
        numsPrefetch = [];
        lockField($num);
        $num.val('');
        destroyAutocomplete($num);
        $btn.prop('disabled', true);
      });
    }

    function prefetchNums(city, street) {
      $.getJSON('/ajax/get_nums', { city, street, term: '' })
        .done(function (nums) {
          numsPrefetch = (nums || []).slice(0, 50);
          if (numsPrefetch.length === 0) {
            $num.val(ALL_NUM);
            lockField($num);
            destroyAutocomplete($num);
            $btn.prop('disabled', false);
            return;
          }
          unlockField($num);
          $num.val('');
          initNums(city, street);
          $btn.prop('disabled', false);
        })
        .fail(function () {
          $num.val(ALL_NUM);
          lockField($num);
          destroyAutocomplete($num);
          $btn.prop('disabled', false);
        });
    }

    function initNums(city, street) {
      destroyAutocomplete($num);
      $num.autocomplete({
        minLength: 0,
        delay: 250,
        autoFocus: true,
        open: setAutocompleteWidth,
        source: function (request, response) {
          const term = (request.term || '').trim();
          if (term.length === 0) {
            response(numsPrefetch.map((v) => ({ label: v, value: v })));
            return;
          }
          $.getJSON('/ajax/get_nums', { city, street, term })
            .done((data) => response((data || []).map((v) => ({ label: v, value: v }))))
            .fail(() => response(numsPrefetch.map((v) => ({ label: v, value: v }))));
        },
        select: function (event, ui) {
          $num.val(ui.item.value);
          $btn.prop('disabled', false);
          return false;
        }
      });

      $num.off('focus.prefetch').on('focus.prefetch', function () {
        if (!$num.prop('disabled')) $(this).autocomplete('search', $(this).val());
      });
    }

    $btn.on('click', function (e) {
      e.preventDefault();
      if ($btn.prop('disabled')) return;

      const cityVal = $city.val().trim();
      const streetVal = ($street.val().trim() || ALL_STREET);
      const numVal = ($num.val().trim() || ALL_NUM);

      $.get(
        '/ajax/start_search',
        { city: cityVal, street: streetVal, num: numVal },
        function (resp) {
          if (resp && resp.redirect) window.location.href = resp.redirect;
        },
        'json'
      );
    });
  });
})(jQuery);

