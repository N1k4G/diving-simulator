/**
 * Whether the dive is being saved (#282). Degraded where the save could not
 * be read, or the store refused the last save it was handed; kept from one
 * dive to the next, so a dive on a page whose storage is blocked says so
 * from its first frame. Legacy says nothing when its save fails
 * (`src/game-loop.js` 1581, a silent catch).
 *
 * The repository settles writes in the order they reach the store, so the
 * outcomes arrive in that order and the last one recorded is the latest. A
 * save replaced by a later save reports that save's outcome, which is about
 * saving too. A save replaced by a clearing reports the clearing's
 * (`cleared`), which says nothing about whether the store takes a save: a
 * removal can be taken where a full quota refuses every write, and refused
 * where the next save is taken. It leaves the state as it was, so the notice
 * neither goes away nor appears because a dive ended.
 */
export class PersistenceStatus {
  #degraded = false;

  get degraded(): boolean {
    return this.#degraded;
  }

  /** The save could not be read: the store is unreachable. */
  unreadable(): void {
    this.#degraded = true;
  }

  /** A save's outcome, as `LocalSaveRepository.save()` resolves it. */
  saveSettled(outcome: { readonly persisted: boolean; readonly cleared: boolean }): void {
    if (!outcome.cleared) {
      this.#degraded = !outcome.persisted;
    }
  }
}
