const fs = require('fs');
const path = require('path');

// 1. Fix reset.css
let resetCss = fs.readFileSync('frontend/css/reset.css', 'utf-8');
resetCss = resetCss.replace(
  "font-family: 'Michroma', sans-serif;",
  "font-family: 'Michroma', sans-serif;\n  font-weight: 400;"
);
resetCss = resetCss.replace(
  "h1, h2, h3, h4, h5, h6 { font-family: 'Goldman', sans-serif; }",
  "h1, h2, h3, h4, h5, h6 { font-family: 'Goldman', sans-serif; font-weight: 700; }"
);
fs.writeFileSync('frontend/css/reset.css', resetCss);

// 2. Fix landing.html fonts and emojis
let landing = fs.readFileSync('frontend/landing.html', 'utf-8');
if (!landing.includes('font-awesome')) {
  landing = landing.replace(
    '</head>',
    '  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">\n</head>'
  );
}
// Add fonts
if (!landing.includes('Michroma')) {
  landing = landing.replace(
    '</head>',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n  <link href="https://fonts.googleapis.com/css2?family=Goldman:wght@700&family=Michroma:wght@400&display=swap" rel="stylesheet">\n</head>'
  );
}

// Replace emojis with fontawesome icons manually based on the context
const emojiMap = {
  '&#128250;': '<i class="fa-solid fa-tv"></i>',
  '&#127916;': '<i class="fa-solid fa-border-all"></i>',
  '&#128421;': '<i class="fa-solid fa-desktop"></i>',
  '&#128197;': '<i class="fa-regular fa-calendar"></i>',
  '&#127926;': '<i class="fa-solid fa-list"></i>',
  '&#127970;': '<i class="fa-solid fa-building"></i>',
  '&#128295;': '<i class="fa-solid fa-wrench"></i>',
  '&#128433;': '<i class="fa-solid fa-hand-pointer"></i>',
  '&#128202;': '<i class="fa-solid fa-chart-line"></i>',
  '&#128276;': '<i class="fa-solid fa-bell"></i>',
  '&#128268;': '<i class="fa-solid fa-plug-circle-xmark"></i>',
  '&#128241;': '<i class="fa-solid fa-mobile-screen"></i>',
  '&#128274;': '<i class="fa-solid fa-server"></i>',
  '&#127912;': '<i class="fa-solid fa-palette"></i>',
  '&#128101;': '<i class="fa-solid fa-users"></i>',
  '&#128260;': '<i class="fa-solid fa-arrows-rotate"></i>',
  '&#128722;': '<i class="fa-solid fa-cart-shopping"></i>',
  '&#127869;': '<i class="fa-solid fa-utensils"></i>',
  '&#127979;': '<i class="fa-solid fa-graduation-cap"></i>',
  '&#127973;': '<i class="fa-solid fa-notes-medical"></i>',
  '&#9962;': '<i class="fa-solid fa-church"></i>',
  '&#127947;': '<i class="fa-solid fa-dumbbell"></i>',
  '&#129302;': '<i class="fa-brands fa-android"></i>',
  '&#128293;': '<i class="fa-brands fa-amazon"></i>',
  '&#129359;': '<i class="fa-brands fa-raspberry-pi"></i>',
  '&#128187;': '<i class="fa-brands fa-windows"></i>',
  '&#127760;': '<i class="fa-brands fa-chrome"></i>'
};

for (const [emoji, icon] of Object.entries(emojiMap)) {
  landing = landing.split(emoji).join(icon);
}

// Add CSS to landing page for fonts
landing = landing.replace(
  '</style>',
  `  body { font-family: 'Michroma', sans-serif; font-weight: 400; }
  h1, h2, h3, h4, h5, h6, .brand { font-family: 'Goldman', sans-serif; font-weight: 700; }
  .feature-icon { font-size: 32px; color: var(--accent); margin-bottom: 16px; }
  .platform-item .icon { font-size: 32px; color: var(--accent); margin-bottom: 8px; }
  </style>`
);

fs.writeFileSync('frontend/landing.html', landing);

console.log('Fixed fonts and emojis');
