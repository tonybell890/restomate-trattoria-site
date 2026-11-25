(function () {
    var lang = new URLSearchParams(location.search).get('lang');
    if (lang === 'it' || lang === 'en') document.getElementById('booking-host').setAttribute('data-lang', lang);
})();
