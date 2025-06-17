const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("Выберите режим:");
console.log("1 - Обучение");
console.log("2 - Ответ на вопросы");
console.log("3 - Обучение с ИИ");

rl.question("Введите номер режима: ", (answer) => {
  if (answer === '1') {
    console.log("[ИНФО] Запущен режим обучения");
    require('./train.js').startTrainingMode(false);
  } else if (answer === '2') {
    console.log("[ИНФО] Запущен режим ответа на вопросы");
    require('./respond.js').startResponseMode();
  } else if (answer === '3') {
    console.log("[ИНФО] Запущен режим обучения с ИИ");
    require('./train.js').startTrainingMode(true);
  } else {
    console.log("[ОШИБКА] Неверный ввод. Пожалуйста, выберите 1, 2 или 3.");
  }
  rl.close();
});