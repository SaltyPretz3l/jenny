async function load(someVariable) {
  const mod = await import('./b.js');
  const other = await import(someVariable);
  return mod || other;
}
