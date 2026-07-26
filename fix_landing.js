const fs = require('fs');

let landing = fs.readFileSync('frontend/landing.html', 'utf-8');

// Replace '$' with '€' in the specific lines
landing = landing.replace('$1,188', '€1,188');
landing = landing.replace('$1,440+', '€1,440+');
landing = landing.replace('$3,600+', '€3,600+');
landing = landing.replace('$1,800+', '€1,800+');
landing = landing.replace("? '$' + p.price_monthly", "? '€' + p.price_monthly");
landing = landing.replace('or $$', 'or €$'); // Actually it's or $${p.price_yearly}, so it becomes or €${p.price_yearly}

// Remove "ScreenTinker" from the header
landing = landing.replace(
  '<span class="nav-logo-text" style="margin-left: 8px;">ScreenTinker</span>',
  ''
);

fs.writeFileSync('frontend/landing.html', landing);
console.log('Fixed landing.html');
