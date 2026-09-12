import fs from 'fs';
import path from 'path';
import { runMetadata } from './run-meta';

// Types for the golden dataset and evaluation results
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
  success: boolean;
  metrics: {
    hitRate: boolean;
    citationAccuracy: boolean;
    noAnswerCompliance: boolean;
    permissionCompliance: boolean;
    keywordCoverage: number;
  };
  details: {
    answer: string;
    citations: string[];
    citation_snippets: Array<{ doc_title: string; snippet: string }>;
    error?: string;
  };
}

// Configuration
const API_URL = process.env.API_URL || 'http://127.0.0.1:3302/api/v1/chat/completions';
const DATASET_PATH = path.join(__dirname, 'golden-dataset.json');
const RESULTS_DIR = path.join(__dirname, 'results');

// Fetch completion via SSE
async function fetchChatCompletion(question: string, authUser: string | null, kbScope?: string[]) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  
  if (authUser) {
    headers['Authorization'] = `Bearer ${authUser}`;
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

    // Read SSE response
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

async function runEvaluation() {
  console.log('Starting evaluation...');
  
  // Read dataset
  const dataset: EvalQuestion[] = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  const results: EvalResult[] = [];
  
  let totalScore = 0;
  
  for (const item of dataset) {
    console.log(`Evaluating ${item.id}: ${item.question}`);
    
    // Test authorized or public access
    const res = await fetchChatCompletion(item.question, item.requires_auth_user, item.expected_kb_scope);
    
    // Metrics
    let hitRate = false;
    let citationAccuracy = false;
    let noAnswerCompliance = false;
    let permissionCompliance = true; // Default true, flip if test fails
    let keywordCoverage = 0;
    
    // Hit Rate & Citation Accuracy
    const returnedTitles = res.citations.map((c: any) => c.doc_title || c.title || c);
    hitRate = item.expected_document_titles.length === 0 || item.expected_document_titles.some(title => returnedTitles.some((rt: string) => typeof rt === 'string' && rt.includes(title)));
    citationAccuracy = returnedTitles.length > 0 ? returnedTitles.some((title: string) => item.expected_document_titles.some(edt => title.includes(edt))) : item.expected_no_answer;
    
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
      keywordCoverage = 1; // N/A, full score
    }

    // Permission Compliance (Test unauthorized users)
    for (const unauthUser of item.unauthorized_users) {
      const unauthRes = await fetchChatCompletion(item.question, unauthUser, item.expected_kb_scope);
      if (unauthRes.answer.length > 0 && !unauthRes.answer.includes('无法根据知识库回答') && !unauthRes.answer.includes('未包含') && unauthRes.status === 200) {
         permissionCompliance = false;
         break;
      }
    }

    // Compile result
    const success = (item.expected_no_answer ? noAnswerCompliance : hitRate) && permissionCompliance;
    if (success) totalScore++;

    // Keep the citation snippet text (SSE timeline_entry.snippet) so judges
    // and offline analysis can verify assertion-evidence entailment.
    const citationSnippets = res.citations.map((c: any) => ({
      doc_title: String(c?.doc_title || c?.title || ''),
      snippet: String(c?.snippet || c?.evidence || '').slice(0, 800),
    }));

    results.push({
      questionId: item.id,
      success,
      metrics: {
        hitRate,
        citationAccuracy,
        noAnswerCompliance,
        permissionCompliance,
        keywordCoverage
      },
      details: {
        answer: res.answer,
        citations: returnedTitles,
        citation_snippets: citationSnippets,
        error: res.error,
      }
    });
  }

  // Save report
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(RESULTS_DIR, `eval-report-${timestamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    // Run provenance: id, commit, time and golden-corpus fingerprint.
    ...runMetadata(DATASET_PATH),
    summary: { total: dataset.length, score: totalScore }, results }, null, 2));

  // Print summary
  console.log('\n--- Evaluation Summary ---');
  console.log(`Total Questions: ${dataset.length}`);
  console.log(`Passed: ${totalScore}`);
  console.log(`Accuracy: ${((totalScore / dataset.length) * 100).toFixed(2)}%`);
  console.log(`Report saved to: ${reportPath}`);
}

runEvaluation().catch(console.error);
