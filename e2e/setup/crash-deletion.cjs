module.exports = function installDeletionCrash(db) {
  const claim = db.claimResourceDeletion;
  db.claimResourceDeletion = (userId, id) => claim(userId, id, 2);
  db.deleteToolCalls = async function () {
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  };
};
