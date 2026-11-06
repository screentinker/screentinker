(function () {
  if (window.NodeList && !window.NodeList.prototype.forEach) window.NodeList.prototype.forEach = Array.prototype.forEach;
  if (window.HTMLCollection && !window.HTMLCollection.prototype.forEach) window.HTMLCollection.prototype.forEach = Array.prototype.forEach;
  if (window.Element && !window.Element.prototype.remove) window.Element.prototype.remove = function () { if (this.parentNode) this.parentNode.removeChild(this); };
})();
