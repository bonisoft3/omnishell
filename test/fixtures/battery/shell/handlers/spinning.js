// A handler that never finishes. Loading it says nothing — the loop is inside
// the reduce, and nobody calls it — so the budget is the only thing between
// this file and a verb that hangs until CI's wall clock kills the job.
(state, event) => {
  while (true) {}
};
