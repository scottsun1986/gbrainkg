/**
 * RAG Quality Gate for CI/CD
 * 
 * Runs evaluation against the golden dataset and enforces quality thresholds.
 * Exit code 0 = PASS (all thresholds met), Exit code 1 = FAIL (below threshold).
 *
 * Usage:
 *   npx tsx tests/evaluation/quality-gate.ts
 *   
 * Environment variables:
 *   API_URL              - API endpoint (default: http://127.0.0.1:3302/api/v1/chat/completions)
 *   GATE_HIT_RATE        - Min hit rate threshold (default: 0.80)
 *   GATE_KEYWORD_COVERAGE - Min keyword coverage (default: 0.75)
 *   GATE_PERMISSION_RATE  - Min permission compliance (default: 1.00)
 *   GATE_NO_HALLUCINATION - Min no-answer compliance (default: 0.90)
 *   AUTH_TOKEN            - Auth token for API calls
 */
import fs from 'fs';
import path from 'path';

// Types
interface EvalQuestion {
  id: string;
  category: string;
  question: string;
  expected_kb_scope: string[];
  expected_document_titles: string[];
  expected_keywords: string[];
  expected_no_answer: boolean;
  requires_auth_user: string | null;
  unauthorized_users: string[];
  notes: string;
}

interface EvalResult {
  questionId: string;
  category: string;
  success: boolean;
  metrics: {
    hitRate: boolean;
    citationAccuracy: boolean;
    noAnswerCompliance: boolean;
    permissionCompliance: boolean;
    keywordCoverage: number;
    faithfulness: boolean;
    contextPrecision: boolean;
  };
  details: {
    answer: string;
    citations: string[];
    error?: string;
  };
}

// Configuration
const API_URL = process.env.API_URL || 'http://127.0.0.1:3302/api/v1/chat/completions';
const DATASET_PATH = path.join(__dirname, 'golden-dataset.json');
const RESULTS_DIR = path.join(__dirname, 'results');

const GATE_HIT_RATE = parseFloat(process.env.GATE_HIT_RATE || '0.80');
const GATE_KEYWORD_COVERAGE = parseFloat(process.env.GATE_KEYWORD_COVERAGE || '0.75');
const GATE_PERMISSION_RATE = parseFloat(process.env.GATE_PERMISSION_RATE || '1.00');
const GATE_NO_HALLUCINATION = parseFloat(process.env.GATE_NO_HALLUCINATION || '0.90');

// Colors for terminal output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

async function fetchChatCompletion(question: string, authUser: string | null, kbScope?: string[]) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (authUser) {
    headers['Authorization'] = `Bearer ${authUser}`;
  } else if (process.env.AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.AUTH_TOKEN}`;
  }

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: question,
        kb_scope: kbScope,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { answer: '', citations: [], status: response.status };
      }
      return { answer: '', citations: [], status: response.status, error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    let answer = '';
    const citations: any[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const payloadStr = line.slice(6).trim();
        if (payloadStr && payloadStr !== '[DONE]') {
          try {
            const data = JSON.parse(payloadStr);
            if (data.type === 'delta' && data.content) {
              answer += data.content;
            } else if (data.type === 'citation' && data.timeline_entry) {
              citations.push(data.timeline_entry);
            }
          } catch {
            // Ignore partial lines
          }
        }
      }
    }

    return {
      answer,
      citations,
      status: 200,
    };
  } catch (error) {
    return { answer: '', citations: [], status: 500, error: String(error) };
  }
}

async function runQualityGate() {
  console.log(`${colors.cyan}========================================${colors.reset}`);
  console.log(`${colors.cyan}  Starting RAG Quality Gate Evaluation  ${colors.reset}`);
  console.log(`${colors.cyan}========================================${colors.reset}\n`);
  
  if (!fs.existsSync(DATASET_PATH)) {
    console.error(`${colors.red}Dataset not found at ${DATASET_PATH}${colors.reset}`);
    process.exit(1);
  }

  const dataset: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  const results: EvalResult[] = [];
  
  let totalScore = 0;
  
  for (const item of dataset) {
    process.stdout.write(`Evaluating ${colors.yellow}${item.id}${colors.reset}: ${item.question.substring(0, 40)}... `);
    
    // Test authorized or public access
    const res = await fetchChatCompletion(item.question, item.requires_auth_user, item.expected_kb_scope);
    
    let hitRate = false;
    let citationAccuracy = false;
    let noAnswerCompliance = false;
    let permissionCompliance = true;
    let keywordCoverage = 0;
    let faithfulness = true;
    let contextPrecision = false;
    
    const returnedTitles = res.citations.map((c: any) => c.doc_title || c.title || c);
    
    // Hit Rate
    hitRate = item.expected_document_titles.length === 0 || 
      item.expected_document_titles.some(title => returnedTitles.some((rt: string) => typeof rt === 'string' && rt.includes(title)));
    
    // Citation Accuracy
    citationAccuracy = returnedTitles.length > 0 ? 
      returnedTitles.some((title: string) => item.expected_document_titles.some(edt => title.includes(edt))) : 
      item.expected_no_answer;
      
    // Context Precision (Check if expected doc is in top 1/top 3)
    contextPrecision = returnedTitles.length > 0 ? 
      item.expected_document_titles.some(edt => (returnedTitles[0] && typeof returnedTitles[0] === 'string' && returnedTitles[0].includes(edt))) :
      item.expected_no_answer;

    // No-Answer Compliance
    if (item.expected_no_answer) {
      noAnswerCompliance = res.answer.includes('不知道') || res.answer.includes('无法根据知识库回答') || res.answer.includes('未包含') || res.answer.trim() === '';
    } else {
      noAnswerCompliance = res.answer.length > 0 && !res.answer.includes('无法根据知识库回答');
    }
    
    // Keyword Coverage
    if (item.expected_keywords.length > 0) {
      const hits = item.expected_keywords.filter(kw => res.answer.includes(kw));
      keywordCoverage = hits.length / item.expected_keywords.length;
    } else {
      keywordCoverage = 1;
    }
    
    // Faithfulness (Basic: if not expected no answer, must have citations to answer)
    if (!item.expected_no_answer && returnedTitles.length === 0 && res.answer.length > 20 && !res.answer.includes('无法根据知识库回答')) {
      faithfulness = false;
    }

    // Permission Compliance (Test unauthorized users)
    for (const unauthUser of item.unauthorized_users) {
      const unauthRes = await fetchChatCompletion(item.question, unauthUser, item.expected_kb_scope);
      if (unauthRes.answer.length > 0 && !unauthRes.answer.includes('无法根据知识库回答') && !unauthRes.answer.includes('未包含') && unauthRes.status === 200) {
         permissionCompliance = false;
         break;
      }
    }

    const success = (item.expected_no_answer ? noAnswerCompliance : hitRate) && permissionCompliance;
    if (success) totalScore++;

    console.log(success ? `${colors.green}✓ PASS${colors.reset}` : `${colors.red}✗ FAIL${colors.reset}`);

    results.push({
      questionId: item.id,
      category: item.category,
      success,
      metrics: {
        hitRate,
        citationAccuracy,
        noAnswerCompliance,
        permissionCompliance,
        keywordCoverage,
        faithfulness,
        contextPrecision
      },
      details: {
        answer: res.answer,
        citations: returnedTitles,
        error: res.error,
      }
    });
  }

  // Calculate aggregations
  const totalItems = dataset.length;
  
  const aggMetrics = {
    hitRate: results.filter(r => r.metrics.hitRate).length / totalItems,
    keywordCoverage: results.reduce((acc, r) => acc + r.metrics.keywordCoverage, 0) / totalItems,
    permissionCompliance: results.filter(r => r.metrics.permissionCompliance).length / totalItems,
    noAnswerCompliance: results.filter(r => r.metrics.noAnswerCompliance).length / totalItems,
    citationAccuracy: results.filter(r => r.metrics.citationAccuracy).length / totalItems,
    faithfulness: results.filter(r => r.metrics.faithfulness).length / totalItems,
    contextPrecision: results.filter(r => r.metrics.contextPrecision).length / totalItems,
  };

  // Group by category
  const categories = [...new Set(dataset.map(item => item.category))];
  const categoryMetrics: Record<string, any> = {};
  
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat);
    const catTotal = catResults.length;
    categoryMetrics[cat] = {
      total: catTotal,
      hitRate: catResults.filter(r => r.metrics.hitRate).length / catTotal,
      keywordCoverage: catResults.reduce((acc, r) => acc + r.metrics.keywordCoverage, 0) / catTotal,
      successRate: catResults.filter(r => r.success).length / catTotal,
    };
  }

  // Save report
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `quality-gate-report-${timestamp}.json`);
  
  const reportData = {
    timestamp,
    thresholds: {
      GATE_HIT_RATE,
      GATE_KEYWORD_COVERAGE,
      GATE_PERMISSION_RATE,
      GATE_NO_HALLUCINATION
    },
    summary: { 
      total: totalItems, 
      passed: totalScore,
      overallSuccessRate: totalScore / totalItems,
      metrics: aggMetrics,
      byCategory: categoryMetrics
    },
    results 
  };
  
  fs.writeFileSync(reportPath, JSON.stringify(reportData, null, 2));

  // Determine PASS/FAIL against thresholds
  const hitRatePass = aggMetrics.hitRate >= GATE_HIT_RATE;
  const keywordCoveragePass = aggMetrics.keywordCoverage >= GATE_KEYWORD_COVERAGE;
  const permissionRatePass = aggMetrics.permissionCompliance >= GATE_PERMISSION_RATE;
  const noHallucinationPass = aggMetrics.noAnswerCompliance >= GATE_NO_HALLUCINATION;

  const allPassed = hitRatePass && keywordCoveragePass && permissionRatePass && noHallucinationPass;

  // Print Summary Table
  console.log(`\n${colors.cyan}--- Quality Gate Summary ---${colors.reset}`);
  console.log(`Total Evaluated: ${totalItems}`);
  console.log(`Overall Success: ${totalScore}/${totalItems} (${((totalScore / totalItems) * 100).toFixed(1)}%)\n`);
  
  console.log(`Metric                   | Threshold | Actual  | Status`);
  console.log(`-------------------------|-----------|---------|---------`);
  
  const printRow = (name: string, threshold: number, actual: number, passed: boolean) => {
    const namePad = name.padEnd(24, ' ');
    const thresholdPad = threshold.toFixed(2).padEnd(9, ' ');
    const actualPad = actual.toFixed(2).padEnd(7, ' ');
    const statusStr = passed ? `${colors.green}PASS${colors.reset}` : `${colors.red}FAIL${colors.reset}`;
    console.log(`${namePad} | >= ${thresholdPad}| ${actualPad} | ${statusStr}`);
  };

  printRow('Hit Rate', GATE_HIT_RATE, aggMetrics.hitRate, hitRatePass);
  printRow('Keyword Coverage', GATE_KEYWORD_COVERAGE, aggMetrics.keywordCoverage, keywordCoveragePass);
  printRow('Permission Compliance', GATE_PERMISSION_RATE, aggMetrics.permissionCompliance, permissionRatePass);
  printRow('No-Answer Compliance', GATE_NO_HALLUCINATION, aggMetrics.noAnswerCompliance, noHallucinationPass);
  
  console.log(`\nOther Metrics:`);
  console.log(`  Citation Accuracy: ${(aggMetrics.citationAccuracy * 100).toFixed(1)}%`);
  console.log(`  Context Precision: ${(aggMetrics.contextPrecision * 100).toFixed(1)}%`);
  console.log(`  Faithfulness:      ${(aggMetrics.faithfulness * 100).toFixed(1)}%`);

  console.log(`\nReport saved to: ${reportPath}`);

  if (allPassed) {
    console.log(`\n${colors.green}========================================${colors.reset}`);
    console.log(`${colors.green}  QUALITY GATE PASSED                   ${colors.reset}`);
    console.log(`${colors.green}========================================${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`\n${colors.red}========================================${colors.reset}`);
    console.log(`${colors.red}  QUALITY GATE FAILED                   ${colors.reset}`);
    console.log(`${colors.red}========================================${colors.reset}`);
    process.exit(1);
  }
}

runQualityGate().catch(error => {
  console.error(`${colors.red}Unhandled error during evaluation:${colors.reset}`, error);
  process.exit(1);
});
