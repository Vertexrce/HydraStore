// Solarix — shared script helpers (used by pages that include this file)

const CART_KEY = "solarix_cart";

function getCart() {
    try { return JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch { return []; }
}

function saveCart(cart) {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    updateCartBadge();
}

function updateCartBadge() {
    const cart = getCart();
    const badge = document.getElementById("cart-badge");
    if (!badge) return;
    if (cart.length) {
        badge.style.display = "flex";
        badge.textContent = cart.length;
    } else {
        badge.style.display = "none";
    }
}

document.addEventListener("DOMContentLoaded", updateCartBadge);
