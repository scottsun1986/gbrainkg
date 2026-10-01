import { Subscriber } from 'rxjs';
import { authorizationOutput } from './authorization-output';

it('drops an entire pending output batch and aborts when authorization changes', async () => {
  const next = jest.fn(), error = jest.fn(), abort = jest.fn();
  const destination = new Subscriber({ next, error, complete: () => {} });
  const guarded = authorizationOutput(destination, async () => { throw new Error('revoked'); }, abort, 1);
  guarded.next({ type: 'delta', content: 'private' });
  guarded.next({ type: 'citation', title: 'private title' });
  guarded.complete();
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(next).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalled();
  expect(abort).toHaveBeenCalledTimes(1);
});
it('preserves ordering and completes only after the final authorization barrier', async () => {
  const values: number[] = [], complete = jest.fn();
  const check = jest.fn(async () => {});
  const guarded = authorizationOutput(new Subscriber({ next: (value: number) => { values.push(value); }, complete, error: () => {} }), check, () => {}, 1);
  guarded.next(1); guarded.next(2); guarded.complete();
  expect(complete).not.toHaveBeenCalled();
  await new Promise(resolve => setTimeout(resolve, 15));
  expect(values).toEqual([1, 2]);
  expect(check).toHaveBeenCalledTimes(1);
  expect(complete).toHaveBeenCalledTimes(1);
});
