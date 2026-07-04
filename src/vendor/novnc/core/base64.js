/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// From: http://hg.mozilla.org/mozilla-central/raw-file/ec10630b1a54/js/src/devtools/jint/sunspider/string-base64.js

export default {
    /* Convert data (an array of integers) to a Base64 string. */
    toBase64Table: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.split(''),

    encode(data) {
        let result = '';
        const length = data.length;
        const lengthpad = (length % 3);
        // Convert every three bytes to 4 ascii characters.

        for (let i = 0; i < (length - 2); i += 3) {
            result += this.toBase64Table[data[i] >> 2];
            result += this.toBase64Table[((data[i] & 0x03) << 4) + (data[i + 1] >> 4)];
            result += this.toBase64Table[((data[i + 1] & 0x0f) << 2) + (data[i + 2] >> 6)];
            result += this.toBase64Table[data[i + 2] & 0x3f];
        }

        // Convert the remaining 1 or 2 bytes, pad out to 4 characters.
        const j = length - lengthpad;
        if (lengthpad === 2) {
            result += this.toBase64Table[data[j] >> 2];
            result += this.toBase64Table[((data[j] & 0x03) << 4) + (data[j + 1] >> 4)];
            result += this.toBase64Table[(data[j + 1] & 0x0f) << 2];
            result += this.toBase64Table[64];
        } else if (lengthpad === 1) {
            result += this.toBase64Table[data[j] >> 2];
            result += this.toBase64Table[(data[j] & 0x03) << 4];
            result += this.toBase64Table[64];
            result += this.toBase64Table[64];
        }

        return result;
    }
}; /* End of Base64 namespace */
