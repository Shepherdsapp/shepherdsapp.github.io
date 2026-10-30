/* Shepherd: where your server lives, and who looks after people's data.
   api: your Cloudflare Worker's address between the quotes (it ends in .workers.dev, no slash at the end).
   privacy: who runs Shepherd (the data controller) and the email people write to about their data.
   Then commit. */
window.SHEPHERD_CONFIG = {
  api: 'https://shepherd.8pavii.workers.dev',
  privacy: { controller: 'Pavi', contact: 'lostshepherdapp@gmail.com' }
};
