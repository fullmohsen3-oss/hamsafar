'use strict';
/** اصناف خدمت گردشگری — قابل توسعه توسط ادمین نیست اما در seed پر می‌شود */

const SERVICE_TYPES = [
  { id: 1, key: 'flight', title: 'پرواز', unit: 'صندلی', emoji: '✈️' },
  { id: 2, key: 'bus', title: 'اتوبوس', unit: 'صندلی', emoji: '🚌' },
  { id: 3, key: 'train', title: 'قطار', unit: 'کوپه/صندلی', emoji: '🚆' },
  { id: 4, key: 'hotel', type: 'stay', title: 'هتل', unit: 'اتاق', emoji: '🏨' },
  { id: 5, key: 'transfer', title: 'ترانسفر', unit: 'نفر', emoji: '🚐' },
  { id: 6, key: 'tour', title: 'تور محلی/گشت', unit: 'نفر', emoji: '🗺️' },
  { id: 7, key: 'insurance', title: 'بیمه‌نامه', unit: 'نفر', emoji: '🛡️' },
  { id: 8, key: 'other', title: 'سایر خدمات', unit: 'واحد', emoji: '📦' },
];
module.exports = { SERVICE_TYPES };
