const readline = require('readline');
const { startTrainingMode } = require('./train.js');
const { startResponseMode } = require('./respond.js');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function promptMode() {
  console.log('Select mode:');
  console.log('1 - Training');
  console.log('2 - Question answering');
  console.log('3 - Training with AI');
  rl.question('Enter mode number: ', (mode) => {
    try {
      switch (mode.trim()) {
        case '1':
          console.log('INFO: Training mode started');
          if (typeof startTrainingMode !== 'function') {
            throw new Error('startTrainingMode is not defined in train.js');
          }
          startTrainingMode(false);
          break;
        case '2':
          console.log('INFO: Question answering mode started');
          if (typeof startResponseMode !== 'function') {
            throw new Error('startResponseMode is not defined in respond.js');
          }
          startResponseMode();
          break;
        case '3':
          console.log('INFO: AI training mode started');
          if (typeof startTrainingMode !== 'function') {
            throw new Error('startTrainingMode is not defined in train.js');
          }
          startTrainingMode(true);
          break;
        default:
          console.log('ERROR: Invalid mode. Please select 1, 2, or 3.');
          promptMode();
          break;
      }
    } catch (err) {
      console.error('ERROR: Mode start failed - ' + err.message);
      console.error(err.stack);
      promptMode();
    }
  });
}

promptMode();