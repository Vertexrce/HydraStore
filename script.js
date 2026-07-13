// Vestige 6X Script

console.log("Vestige 6X Loaded");

// Smooth scrolling for navbar links

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
anchor.addEventListener('click', function(e) {
e.preventDefault();

```
    const target = document.querySelector(
        this.getAttribute('href')
    );

    if(target){
        target.scrollIntoView({
            behavior:'smooth'
        });
    }
});
```

});

// Fade in cards on load

window.addEventListener('load', () => {

```
const cards = document.querySelectorAll(
    '.stat-card, .news-card, .feature-box, .store-card'
);

cards.forEach((card, index) => {

    card.style.opacity = '0';
    card.style.transform = 'translateY(20px)';

    setTimeout(() => {

        card.style.transition =
        'all .6s ease';

        card.style.opacity = '1';
        card.style.transform =
        'translateY(0)';

    }, index * 100);

});
```

});

// Countdown placeholder

const launchDate = new Date(
"December 31, 2026 12:00:00"
).getTime();

setInterval(() => {

```
const now = new Date().getTime();

const distance =
launchDate - now;

const days =
Math.floor(
    distance /
    (1000 * 60 * 60 * 24)
);

const countdown =
document.getElementById(
    "countdown"
);

if(countdown){
    countdown.innerHTML =
    days + " Days";
}
```

},1000);
