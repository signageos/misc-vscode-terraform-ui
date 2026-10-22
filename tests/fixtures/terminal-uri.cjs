const { URI } = require('vscode-uri');

function uri(parts) { return URI.from({ scheme: 'file', authority: '', path: '', query: '', fragment: '', ...parts }); }

module.exports = { uri };
