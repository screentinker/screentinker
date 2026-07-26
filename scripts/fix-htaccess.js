const fs = require('fs');
const path = require('path');

// Hostinger often creates .htaccess either in the current app dir or public_html
const possiblePaths = [
  path.resolve(__dirname, '../.htaccess'),
  path.resolve(__dirname, '../../.htaccess'),
  path.resolve(__dirname, '../../public_html/.htaccess')
];

let fixed = false;

for (const htaccessPath of possiblePaths) {
  try {
    if (fs.existsSync(htaccessPath)) {
      let content = fs.readFileSync(htaccessPath, 'utf8');
      
      // Hostinger auto-appends this line during git deployment, which crashes the app
      if (content.includes('SetEnv NODE_OPTIONS')) {
        console.log(`[fix-htaccess] Found bad Hostinger config in ${htaccessPath}`);
        
        // Remove the offending line completely
        content = content.replace(/^.*SetEnv NODE_OPTIONS.*$/gm, '');
        
        // Add a commented-out version to trick Hostinger's auto-injector into thinking it's already there
        if (!content.includes('# SetEnv NODE_OPTIONS --use-openssl-ca')) {
          content = content.trim() + '\n# SetEnv NODE_OPTIONS --use-openssl-ca\n';
        }
        
        fs.writeFileSync(htaccessPath, content, 'utf8');
        console.log(`[fix-htaccess] Successfully removed SetEnv NODE_OPTIONS!`);
        fixed = true;
      }
    }
  } catch (err) {
    console.error(`[fix-htaccess] Error checking ${htaccessPath}:`, err.message);
  }
}

if (!fixed) {
  console.log('[fix-htaccess] No .htaccess modifications needed.');
}
