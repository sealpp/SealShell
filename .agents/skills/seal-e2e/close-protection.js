const assert = require('assert/strict');

async function confirmReload(page) {
  const confirmation = page.waitForEvent('dialog', { timeout: 10000 }).then(async dialog => {
    assert.equal(dialog.type(), 'beforeunload');
    await dialog.accept();
  });
  await Promise.all([confirmation, page.reload()]);
}

module.exports = { confirmReload };
