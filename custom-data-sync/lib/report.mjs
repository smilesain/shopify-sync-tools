import { writeFileSync } from 'node:fs';

export function createEmptyReport({ sourceShop, targetShop, dryRun, only }) {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    sourceShop,
    targetShop,
    dryRun,
    only,
    metaobjects: {
      sourceCount: 0,
      targetCount: 0,
      created: [],
      planned: [],
      skipped: [],
      failed: [],
    },
    metafields: {
      sourceCount: 0,
      targetCount: 0,
      created: [],
      planned: [],
      skipped: [],
      failed: [],
    },
  };
}

export function finalizeReport(report) {
  report.finishedAt = new Date().toISOString();
  return report;
}

export function printSummary(report) {
  const createdMetaobjects = report.dryRun
    ? report.metaobjects.planned.length
    : report.metaobjects.created.length;
  const createdMetafields = report.dryRun
    ? report.metafields.planned.length
    : report.metafields.created.length;

  console.log('\n=== Sync Summary ===');
  console.log(`Mode: ${report.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Source: ${report.sourceShop}`);
  console.log(`Target: ${report.targetShop}`);

  if (report.only === 'all' || report.only === 'metaobjects') {
    console.log('\nMetaobject definitions:');
    console.log(`  Source: ${report.metaobjects.sourceCount}`);
    console.log(`  Target before sync: ${report.metaobjects.targetCount}`);
    console.log(`  ${report.dryRun ? 'Planned' : 'Created'}: ${createdMetaobjects}`);
    console.log(`  Skipped: ${report.metaobjects.skipped.length}`);
    console.log(`  Failed: ${report.metaobjects.failed.length}`);
  }

  if (report.only === 'all' || report.only === 'metafields') {
    console.log('\nMetafield definitions:');
    console.log(`  Source: ${report.metafields.sourceCount}`);
    console.log(`  Target before sync: ${report.metafields.targetCount}`);
    console.log(`  ${report.dryRun ? 'Planned' : 'Created'}: ${createdMetafields}`);
    console.log(`  Skipped: ${report.metafields.skipped.length}`);
    console.log(`  Failed: ${report.metafields.failed.length}`);
  }

  const totalFailed = report.metaobjects.failed.length + report.metafields.failed.length;
  if (totalFailed > 0) {
    console.log('\nSome items failed. Check the report JSON for details.');
  }
}

export function writeReport(report, reportPath) {
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`\nReport written to ${reportPath}`);
}
