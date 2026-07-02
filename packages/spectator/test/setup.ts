// Ensure #app element exists before any module that reads it runs.
if (!document.getElementById('app')) {
  const el = document.createElement('div')
  el.id = 'app'
  document.body.appendChild(el)
}