import { generateRelayUsername } from 'src/common/utils/relay-email.util';

describe('relay-email.util', () => {
  describe('generateRelayUsername', () => {
    describe('Given repeated invocations', () => {
      it('When called, Then always returns a 10-character string', () => {
        for (let i = 0; i < 100; i++) {
          const username = generateRelayUsername();
          const fullEmailAddress = username.concat('@private-mailhub.com');
          expect(username).toHaveLength(10);
          expect(fullEmailAddress).toHaveLength(30);
        }
      });

      it('When called, Then matches the pattern of 4-char and 5-char alphanumeric segments joined by "-"', () => {
        const pattern = /^[a-z0-9]{4}-[a-z0-9]{5}$/;
        for (let i = 0; i < 100; i++) {
          const username = generateRelayUsername();
          expect(username).toMatch(pattern);
        }
      });

      it('When called, Then the first character is always a lowercase English letter', () => {
        for (let i = 0; i < 100; i++) {
          const username = generateRelayUsername();
          expect(username[0]).toMatch(/^[a-z]$/);
        }
      });

      it('When called many times, Then the produced characters include both lowercase letters and digits', () => {
        let combined = '';
        for (let i = 0; i < 100; i++) {
          combined += generateRelayUsername().replace('-', '');
        }

        expect(combined).toMatch(/[a-z]/);
        expect(combined).toMatch(/[0-9]/);
      });
    });
  });
});
