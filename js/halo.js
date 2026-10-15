// Pricing toggle: per-event <-> subscription
(function(){
  var tabs = document.querySelectorAll('.toggle-btn');
  var groups = document.querySelectorAll('[data-plan-group]');
  function show(plan){
    tabs.forEach(function(t){
      var on = t.getAttribute('data-plan') === plan;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    groups.forEach(function(g){
      g.classList.toggle('hidden', g.getAttribute('data-plan-group') !== plan);
    });
  }
  tabs.forEach(function(t){
    t.addEventListener('click', function(){ show(t.getAttribute('data-plan')); });
  });
})();
