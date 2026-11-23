/** A named demo content set whose module fails while loading, for the loader tests. */
export default ((): never => {
  throw new Error('sample failure while loading the set');
})();
