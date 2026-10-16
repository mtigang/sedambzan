import ora from 'ora';

export function createSpinner(text) {
  return ora({ text, color: 'cyan' });
}
