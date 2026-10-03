import { buildBillingForward, STATUS_TITLES } from "./forward.js";

const { target, status } = buildBillingForward(window.location.search);
const link = document.getElementById("open");
if (link) link.setAttribute("href", target);
if (status) {
  const title = document.getElementById("title");
  if (title) title.textContent = STATUS_TITLES[status];
  window.location.replace(target);
}
