import { render, fireEvent } from '@testing-library/react';
import { SignaturePad } from './SignaturePad';

// jsdom has no canvas: give it a no-op 2D context and a fixed PNG export so
// the pad's own logic (when it emits a drawing, when it emits '') is tested.
const FAKE_PNG = 'data:image/png;base64,FAKE';
const ctx = {
  scale() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, drawImage() {},
  lineWidth: 0, lineCap: '', lineJoin: '', strokeStyle: '', fillStyle: '',
};
beforeEach(() => {   // CRA resets mocks before every test
  jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx);
  jest.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => FAKE_PNG);
});
afterEach(() => jest.restoreAllMocks());

const canvasOf = (container) => container.querySelector('canvas');

test('a tap with no movement emits no drawing (blank pad)', () => {
  const onChange = jest.fn();
  const { container } = render(<SignaturePad onChange={onChange} exportMaxWidth={600} />);
  const c = canvasOf(container);
  fireEvent.mouseDown(c, { clientX: 10, clientY: 10 });
  fireEvent.mouseUp(c, { clientX: 10, clientY: 10 });
  expect(onChange).toHaveBeenLastCalledWith('');
  expect(container.textContent).toContain('Sign above');
});

test('a stroke emits the PNG, Clear empties it again', () => {
  const onChange = jest.fn();
  const { container, getByText } = render(<SignaturePad onChange={onChange} exportMaxWidth={600} />);
  const c = canvasOf(container);
  fireEvent.mouseDown(c, { clientX: 10, clientY: 10 });
  fireEvent.mouseMove(c, { clientX: 30, clientY: 14 });
  fireEvent.mouseUp(c, { clientX: 30, clientY: 14 });
  expect(onChange).toHaveBeenLastCalledWith(FAKE_PNG);
  expect(container.textContent).toContain('✓ Signed');

  fireEvent.click(getByText('Clear'));
  expect(onChange).toHaveBeenLastCalledWith('');
  // After Clear, a tap alone is blank again.
  fireEvent.mouseDown(c, { clientX: 10, clientY: 10 });
  fireEvent.mouseUp(c, { clientX: 10, clientY: 10 });
  expect(onChange).toHaveBeenLastCalledWith('');
});
