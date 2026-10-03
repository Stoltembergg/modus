// Supabase appends tokens or a code to this landing page. Nothing here reads them; they are
// dropped from the address bar so they are not kept in history or shared by copy-paste.
if (window.location.search || window.location.hash) {
  window.history.replaceState(null, "", window.location.pathname);
}
