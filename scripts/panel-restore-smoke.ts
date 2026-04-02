/**
 * 패널 복구·상태 경로 점검 안내 (실제 Discord API 호출 없음).
 * 실행: npx ts-node scripts/panel-restore-smoke.ts
 */
import { LOG_DIR, HEALTH_FILE } from '../logger';

console.log('[panel-restore-smoke] manual checks:');
console.log('- !메뉴 / !패널재설치 로 메인 패널 재설치');
console.log('- 데이터 센터에서 패널 복구 실패 시 logs/office-health.json 의 panels.* 확인');
console.log(`- log dir: ${LOG_DIR}`);
console.log(`- health file: ${HEALTH_FILE}`);
