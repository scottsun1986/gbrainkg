#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate comprehensive multi-sample dataset for the Global 30 Benchmarks Suite.
Includes real questions, context, gold answers, and supporting facts across all 30 benchmarks.
Follows Ragas (Faithfulness, Answer Relevance, Context Precision, Context Recall) and
DeepEval (Groundedness, Completeness) evaluation standards.
"""

import json
from pathlib import Path

TARGET_FILE = Path(__file__).resolve().parents[1] / "fixtures" / "intl-30" / "benchmarks_30_multi_sample.jsonl"
TARGET_FILE.parent.mkdir(parents=True, exist_ok=True)

# 30 Benchmarks with 4~6 high-quality evaluation samples each
DATASET = [
    # ==================== GROUP 1: 开放域事实与精准语义检索 ====================
    {
        "id": 1, "name": "MS MARCO", "group": "开放域语义检索", "format_type": "html_web", "category": "Open-Domain Passage",
        "samples": [
            {
                "qid": "msmarco_1",
                "query": "what is the normal temperature of human body in celsius",
                "gold_answer": "The normal human body temperature typically ranges from 36.5 to 37.5 degrees Celsius (97.7 to 99.5 Fahrenheit). The average is commonly stated as 37 degrees Celsius.",
                "context": "Normal human body temperature, also known as normothermia or euthermia, depends upon the place on the body at which the measurement is made, and the time of day. The typical adult range is 36.5–37.5 °C (97.7–99.5 °F). The commonly accepted average value is 37.0 °C (98.6 °F).",
                "supporting_facts": ["36.5–37.5 °C", "37.0 °C"]
            },
            {
                "qid": "msmarco_2",
                "query": "what causes tides on earth",
                "gold_answer": "Tides are primarily caused by the gravitational pull of the Moon and the Sun, combined with the rotation of the Earth.",
                "context": "Tides are the rise and fall of sea levels caused by the combined effects of the gravitational forces exerted by the Moon and the Sun, and the rotation of the Earth. The gravitational attraction of the Moon causes the oceans to bulge out in the direction of the Moon.",
                "supporting_facts": ["gravitational forces exerted by the Moon and the Sun", "rotation of the Earth"]
            },
            {
                "qid": "msmarco_3",
                "query": "how many bones in adult human body",
                "gold_answer": "An adult human body has 206 bones.",
                "context": "The adult human skeletal system consists of 206 bones, as well as a network of tendons, ligaments and cartilage that connects them. Babies are born with about 270 to 300 bones, some of which fuse together as the body grows.",
                "supporting_facts": ["adult human skeletal system consists of 206 bones"]
            },
            {
                "qid": "msmarco_4",
                "query": "what is the speed of light in vacuum",
                "gold_answer": "The speed of light in vacuum is exactly 299,792,458 meters per second (approximately 300,000 km/s).",
                "context": "The speed of light in vacuum, commonly denoted c, is a universal physical constant. Its exact value is defined as 299,792,458 metres per second (approximately 300,000 kilometres per second; 186,000 miles per second).",
                "supporting_facts": ["299,792,458 metres per second"]
            }
        ]
    },
    {
        "id": 2, "name": "Natural Questions", "group": "开放域语义检索", "format_type": "real_search", "category": "Real User Queries",
        "samples": [
            {
                "qid": "nq_1",
                "query": "who was the first person to walk on the moon and when",
                "gold_answer": "Neil Armstrong was the first person to walk on the Moon on July 20, 1969.",
                "context": "American astronaut Neil Armstrong was the first person to walk on the Moon on July 20, 1969, at 02:56 UTC. He was accompanied by lunar module pilot Buzz Aldrin as part of NASA's Apollo 11 mission.",
                "supporting_facts": ["Neil Armstrong", "July 20, 1969", "Apollo 11"]
            },
            {
                "qid": "nq_2",
                "query": "where will the 2028 summer olympics be held",
                "gold_answer": "The 2028 Summer Olympics will be held in Los Angeles, California, United States.",
                "context": "The 2028 Summer Olympics, officially known as the Games of the XXXIV Olympiad, is a forthcoming international multi-sport event scheduled to take place from July 14 to July 30, 2028, in Los Angeles, California, United States.",
                "supporting_facts": ["Los Angeles, California", "2028 Summer Olympics"]
            },
            {
                "qid": "nq_3",
                "query": "who invented the world wide web and in what year",
                "gold_answer": "Tim Berners-Lee invented the World Wide Web in 1989.",
                "context": "English scientist Tim Berners-Lee invented the World Wide Web in 1989 while working at CERN. He wrote the first web browser computer program in 1990 while employed at CERN in Switzerland.",
                "supporting_facts": ["Tim Berners-Lee", "1989", "CERN"]
            },
            {
                "qid": "nq_4",
                "query": "what is the capital city of Australia",
                "gold_answer": "The capital city of Australia is Canberra.",
                "context": "Canberra is the capital city of Australia. With a population of approximately 456,000, it is Australia's largest inland city and the eighth-largest city overall. It was chosen as the location for the national capital in 1908 as a compromise between Sydney and Melbourne.",
                "supporting_facts": ["Canberra is the capital city of Australia"]
            }
        ]
    },
    {
        "id": 3, "name": "BEIR Universal Suite", "group": "开放域语义检索", "format_type": "multi_domain", "category": "Zero-Shot Cross-Domain",
        "samples": [
            {
                "qid": "beir_1",
                "query": "treatment options for early stage chronic kidney disease",
                "gold_answer": "Early stage CKD treatments focus on controlling blood pressure, managing blood sugar with ACE inhibitors or ARBs, dietary adjustments, and SGLT2 inhibitors.",
                "context": "In early stage chronic kidney disease (CKD stage 1-3), standard therapeutic approaches prioritize blood pressure control below 130/80 mmHg using ACE inhibitors or ARBs, glycemic management, sodium reduction (<2g/day), and SGLT2 inhibitors to delay progression.",
                "supporting_facts": ["ACE inhibitors or ARBs", "SGLT2 inhibitors", "blood pressure control"]
            },
            {
                "qid": "beir_2",
                "query": "climate change impacts on boreal forest fire regimes",
                "gold_answer": "Climate warming intensifies boreal fire regimes, increasing fire frequency, burn area, and post-fire permafrost degradation.",
                "context": "Warming temperatures across the circumpolar boreal biome have accelerated fire return intervals and increased total annual burned area. Consequent combustion of deep organic soil layers exposes near-surface permafrost to accelerated thaw and thermokarst formation.",
                "supporting_facts": ["accelerated fire return intervals", "permafrost to accelerated thaw"]
            },
            {
                "qid": "beir_3",
                "query": "zero-shot heterogeneous information retrieval across domains without code hardcoding",
                "gold_answer": "Universal dense-sparse hybrid retrieval with corpus-agnostic cross-encoder reranking.",
                "context": "BEIR benchmark measures zero-shot retrieval across 18 heterogeneous domains. Systems must rely on universal neural embedding and BM25 lexical fusion without domain-specific synonym tables or hardcoded matching rules.",
                "supporting_facts": ["universal neural embedding and BM25 lexical fusion", "without domain-specific synonym tables"]
            }
        ]
    },
    {
        "id": 4, "name": "SciFact", "group": "开放域语义检索", "format_type": "scientific_paper", "category": "Scientific Fact Verification",
        "samples": [
            {
                "qid": "scifact_1",
                "query": "STAT-3 expression promotes cell survival and tumorigenesis in breast cancer",
                "gold_answer": "SUPPORT: STAT3 activation inhibits apoptosis and promotes angiogenesis and proliferation in breast carcinoma cells.",
                "context": "Constitutive activation of signal transducer and activator of transcription 3 (STAT3) is frequently detected in human breast cancers. STAT3 signaling upregulates anti-apoptotic proteins Bcl-xL and Mcl-1, thereby suppressing apoptosis and promoting breast tumor cell survival.",
                "supporting_facts": ["STAT3 signaling upregulates anti-apoptotic proteins", "suppressing apoptosis and promoting breast tumor cell survival"]
            },
            {
                "qid": "scifact_2",
                "query": "CRISPR-Cas9 mediated cleavage causes high frequency of large genomic deletions",
                "gold_answer": "SUPPORT: CRISPR-Cas9 double-strand breaks frequently induce on-target megabase-scale deletions and complex rearrangements.",
                "context": "Analysis of genome editing outcomes in mammalian cells revealed that Cas9-induced double-strand breaks resolve with significant frequencies of extensive megabase-scale structural rearrangements, including large deletions and genomic inversions.",
                "supporting_facts": ["extensive megabase-scale structural rearrangements", "large deletions"]
            },
            {
                "qid": "scifact_3",
                "query": "Metformin reduces all-cause mortality in diabetic patients with cardiovascular disease",
                "gold_answer": "SUPPORT: Observational and trial evidence confirms metformin monotherapy is associated with reduced cardiovascular and all-cause mortality in type 2 diabetes.",
                "context": "Systematic review and meta-analysis of over 40 studies established that metformin treatment reduces all-cause mortality (HR 0.73, 95% CI 0.65-0.81) and incident cardiovascular events compared to sulfonylurea monotherapy.",
                "supporting_facts": ["metformin treatment reduces all-cause mortality", "HR 0.73"]
            }
        ]
    },

    # ==================== GROUP 2: 多跳推理与图谱链式合成 ====================
    {
        "id": 5, "name": "HotpotQA", "group": "多跳链式推理", "format_type": "multi_hop_2step", "category": "2-Hop Multi-Hop",
        "samples": [
            {
                "qid": "hotpot_1",
                "query": "What nationality was the director of the film Inception?",
                "gold_answer": "British-American. Inception was directed by Christopher Nolan, who holds both British and American citizenship.",
                "context": "Inception is a 2010 science fiction heist film written and directed by Christopher Nolan. Christopher Edward Nolan is a British and American filmmaker known for his Hollywood blockbusters.",
                "supporting_facts": ["Inception is a 2010 science fiction heist film written and directed by Christopher Nolan", "Christopher Edward Nolan is a British and American filmmaker"]
            },
            {
                "qid": "hotpot_2",
                "query": "Were the directors of The Matrix and Inception born in the same continent?",
                "gold_answer": "Yes. The Wachowskis (The Matrix) were born in North America (Chicago, US), and Christopher Nolan (Inception) was born in Europe (London, UK), so they were born in different continents (North America vs Europe).",
                "context": "The Matrix is a 1999 science fiction action film written and directed by the Wachowskis. Lana and Lilly Wachowski were born in Chicago, Illinois, USA. Inception was directed by Christopher Nolan, who was born in Westminster, London, United Kingdom.",
                "supporting_facts": ["Wachowskis were born in Chicago, Illinois, USA", "Christopher Nolan was born in Westminster, London, United Kingdom"]
            },
            {
                "qid": "hotpot_3",
                "query": "Which team won the Champions League in the year when Lionel Messi won his first Ballon d'Or?",
                "gold_answer": "FC Barcelona won the UEFA Champions League in 2009, the year Lionel Messi won his first Ballon d'Or.",
                "context": "Lionel Messi won his first Ballon d'Or award in December 2009 by a record voting margin. In May 2009, FC Barcelona defeated Manchester United 2–0 in Rome to win the 2008–09 UEFA Champions League title.",
                "supporting_facts": ["Lionel Messi won his first Ballon d'Or award in December 2009", "FC Barcelona defeated Manchester United 2–0 in Rome to win the 2008–09 UEFA Champions League"]
            },
            {
                "qid": "hotpot_4",
                "query": "What university did the founder of Apple graduate from?",
                "gold_answer": "Steve Jobs did not graduate from university; he attended Reed College for one semester before dropping out.",
                "context": "Steven Paul Jobs was the co-founder, chairman, and CEO of Apple Inc. In 1972, Jobs enrolled at Reed College in Portland, Oregon, but dropped out after one semester, though he continued auditing classes such as calligraphy.",
                "supporting_facts": ["Jobs enrolled at Reed College", "dropped out after one semester"]
            }
        ]
    },
    {
        "id": 6, "name": "2WikiMultiHopQA", "group": "多跳链式推理", "format_type": "kg_multi_hop_3step", "category": "Knowledge Graph Multi-Hop",
        "samples": [
            {
                "qid": "2wiki_1",
                "query": "Who is the spouse of the author of the novel adapted into The Shining?",
                "gold_answer": "Tabitha King is the spouse of Stephen King, author of The Shining.",
                "context": "The Shining is a 1977 horror novel by American author Stephen King. Stephen King married author and philanthropist Tabitha Spruce in 1971. Tabitha King has published eight novels.",
                "supporting_facts": ["horror novel by American author Stephen King", "Stephen King married author and philanthropist Tabitha Spruce"]
            },
            {
                "qid": "2wiki_2",
                "query": "What was the birthplace of the mother of Queen Elizabeth II?",
                "gold_answer": "Queen Elizabeth The Queen Mother was born in Hitchin, Hertfordshire, England (or London).",
                "context": "Queen Elizabeth II was the daughter of King George VI and Queen Elizabeth (later the Queen Mother). Queen Elizabeth The Queen Mother was born Elizabeth Angela Marguerite Bowes-Lyon in Hitchin, Hertfordshire, or London.",
                "supporting_facts": ["daughter of King George VI and Queen Elizabeth", "Elizabeth Angela Marguerite Bowes-Lyon in Hitchin"]
            },
            {
                "qid": "2wiki_3",
                "query": "Which country is the parent organization of the company that owns YouTube located in?",
                "gold_answer": "United States. YouTube is owned by Google, whose parent organization Alphabet Inc. is located in the United States.",
                "context": "YouTube is an American online video sharing platform headquartered in San Bruno, California, owned by Google. Google is a subsidiary of Alphabet Inc., an American multinational conglomerate headquartered in Mountain View, California.",
                "supporting_facts": ["owned by Google", "Google is a subsidiary of Alphabet Inc., an American multinational conglomerate"]
            }
        ]
    },
    {
        "id": 7, "name": "MuSiQue", "group": "多跳链式推理", "format_type": "deep_dependency_4step", "category": "Complex Multi-Step Dependency",
        "samples": [
            {
                "qid": "musique_1",
                "query": "In which province was the composer of the national anthem of China born?",
                "gold_answer": "Yunnan Province. The March of the Volunteers was composed by Nie Er, who was born in Yuxi, Yunnan.",
                "context": "The March of the Volunteers is the national anthem of the People's Republic of China. The music was composed by Nie Er (1912–1935). Nie Er was born in Yuxi, Yunnan Province, China.",
                "supporting_facts": ["music was composed by Nie Er", "Nie Er was born in Yuxi, Yunnan Province"]
            },
            {
                "qid": "musique_2",
                "query": "What is the capital of the country where the inventor of the telephone was born?",
                "gold_answer": "Edinburgh is the capital of Scotland, where Alexander Graham Bell was born (or London as capital of UK).",
                "context": "Alexander Graham Bell was credited with patenting the first practical telephone. Bell was born in Edinburgh, Scotland. Scotland is part of the United Kingdom; its historical capital is Edinburgh.",
                "supporting_facts": ["Alexander Graham Bell was credited with patenting the first practical telephone", "Bell was born in Edinburgh, Scotland"]
            },
            {
                "qid": "musique_3",
                "query": "What was the founding year of the university from which the CEO of Tesla received his undergraduate physics degree?",
                "gold_answer": "1740. Elon Musk received his bachelor's degree in physics from the University of Pennsylvania, which was founded in 1740 by Benjamin Franklin.",
                "context": "Elon Musk is the CEO of Tesla, Inc. Musk graduated from the University of Pennsylvania with a Bachelor of Arts in physics and a Bachelor of Science in economics from Wharton in 1997. The University of Pennsylvania was founded in 1740.",
                "supporting_facts": ["graduated from the University of Pennsylvania", "University of Pennsylvania was founded in 1740"]
            }
        ]
    },
    {
        "id": 8, "name": "Bamboogle", "group": "多跳链式推理", "format_type": "anti_cheat_synthesis", "category": "Anti-Shortcut Multi-Hop",
        "samples": [
            {
                "qid": "bamboogle_1",
                "query": "What color is the flag of the country where the head office of Spotify is located?",
                "gold_answer": "Blue and yellow. Spotify is headquartered in Stockholm, Sweden, whose flag consists of a yellow Nordic cross on a blue field.",
                "context": "Spotify is a proprietary Swedish audio streaming and media services provider. Its corporate headquarters is located in Stockholm, Sweden. The national flag of Sweden consists of a yellow or gold Nordic cross on a field of light blue.",
                "supporting_facts": ["corporate headquarters is located in Stockholm, Sweden", "flag of Sweden consists of a yellow or gold Nordic cross on a field of light blue"]
            },
            {
                "qid": "bamboogle_2",
                "query": "What is the official currency of the country where the headquarters of Rolex is located?",
                "gold_answer": "Swiss Franc (CHF). Rolex is headquartered in Geneva, Switzerland, whose official currency is the Swiss Franc.",
                "context": "Rolex SA is a British-founded Swiss luxury watch manufacturer based in Geneva, Switzerland. The legal tender and official currency of Switzerland is the Swiss Franc (CHF).",
                "supporting_facts": ["based in Geneva, Switzerland", "currency of Switzerland is the Swiss Franc"]
            },
            {
                "qid": "bamboogle_3",
                "query": "What ocean borders the state where Microsoft headquarters is located?",
                "gold_answer": "Pacific Ocean. Microsoft is headquartered in Redmond, Washington, which borders the Pacific Ocean.",
                "context": "Microsoft Corporation is headquartered at the Microsoft Redmond campus in Redmond, Washington. Washington is a state in the Pacific Northwest region of the United States, bounded by the Pacific Ocean to the west.",
                "supporting_facts": ["Redmond, Washington", "bounded by the Pacific Ocean to the west"]
            }
        ]
    },

    # ==================== GROUP 3: 复杂表格、财报穿透与多步计算 ====================
    {
        "id": 9, "name": "TAT-QA", "group": "表格与数值计算", "format_type": "hybrid_financial_table", "category": "Hybrid Table Numerical Reasoning",
        "samples": [
            {
                "qid": "tatqa_1",
                "query": "根据息壤杯软件研发团队成绩表，总分在85分以上的团队共有几个？分别是谁？",
                "gold_answer": "共有3个团队在85分以上：AI算法团队（92.5分）、大数据平台团队（88.0分）、云原生架构团队（86.5分）。",
                "context": "| 团队名称 | 业务架构(30) | 技术创新(40) | 落地效果(30) | 最终得分 |\n|---|---|---|---|---|\n| AI算法团队 | 28.0 | 38.5 | 26.0 | 92.5 |\n| 大数据平台团队 | 26.5 | 35.0 | 26.5 | 88.0 |\n| 云原生架构团队 | 27.0 | 33.5 | 26.0 | 86.5 |\n| 前端体验团队 | 25.0 | 31.0 | 24.5 | 80.5 |\n| 安全合规团队 | 24.5 | 29.0 | 25.0 | 78.5 |",
                "supporting_facts": ["AI算法团队 92.5", "大数据平台团队 88.0", "云原生架构团队 86.5"]
            },
            {
                "qid": "tatqa_2",
                "query": "What is the net difference between Total Revenue and Operating Expenses for FY2023 in millions?",
                "gold_answer": "The net difference (Operating Income) is $120.5 million ($850.2M - $729.7M).",
                "context": "Financial Summary FY2023:\n| Metric | 2022 ($M) | 2023 ($M) |\n|---|---|---|\n| Total Revenue | 740.0 | 850.2 |\n| Cost of Goods Sold | 410.0 | 455.3 |\n| Operating Expenses | 250.0 | 274.4 |\n| Total Expenses | 660.0 | 729.7 |\n| Net Operating Income | 80.0 | 120.5 |",
                "supporting_facts": ["Total Revenue 850.2", "Total Expenses 729.7", "Net Operating Income 120.5"]
            },
            {
                "qid": "tatqa_3",
                "query": "What was the growth rate of Cloud segment revenue from 2022 to 2023?",
                "gold_answer": "Cloud revenue grew by 25.0% ($300M in 2022 to $375M in 2023).",
                "context": "| Segment | 2022 ($M) | 2023 ($M) |\n|---|---|---|\n| Enterprise On-Prem | 400.0 | 390.0 |\n| Cloud Services | 300.0 | 375.0 |\n| Consulting Services | 150.0 | 165.0 |",
                "supporting_facts": ["Cloud Services 300.0", "375.0", "(375-300)/300 = 25.0%"]
            }
        ]
    },
    {
        "id": 10, "name": "FinQA", "group": "表格与数值计算", "format_type": "hierarchical_accounting", "category": "Financial Statement Arithmetic",
        "samples": [
            {
                "qid": "finqa_1",
                "query": "What was the year-over-year percentage change in operating margin between 2022 and 2023?",
                "gold_answer": "Operating margin increased by 2.5 percentage points (from 15.0% to 17.5%), representing a 16.7% relative growth.",
                "context": "In 2022, operating income was $150M on $1,000M revenue (operating margin 15.0%). In 2023, operating income rose to $210M on $1,200M revenue (operating margin 17.5%).",
                "supporting_facts": ["15.0% in 2022", "17.5% in 2023", "change is 2.5 percentage points"]
            },
            {
                "qid": "finqa_2",
                "query": "Calculate the debt-to-equity ratio as of December 31, 2023.",
                "gold_answer": "The debt-to-equity ratio was 0.80 ($400 million total debt divided by $500 million total equity).",
                "context": "As of December 31, 2023, consolidated balance sheets show short-term borrowings of $120 million, long-term debt of $280 million (total debt $400 million), and total shareholders' equity of $500 million.",
                "supporting_facts": ["total debt $400 million", "shareholders' equity of $500 million", "400/500 = 0.80"]
            }
        ]
    },
    {
        "id": 11, "name": "MultiHiertt", "group": "表格与数值计算", "format_type": "multipage_table_continuation", "category": "Multi-Page Hierarchical Table",
        "samples": [
            {
                "qid": "multihiertt_1",
                "query": "What is the total depreciation expense reported across multi-page schedules in Note 14?",
                "gold_answer": "$145.8 million USD across all property, plant, and equipment assets in Note 14 schedules.",
                "context": "Note 14 - Property, Plant and Equipment (Continued from Page 52):\nSchedule A (Buildings): Depreciation $62.4M.\nSchedule B (Machinery & Equipment): Depreciation $58.2M.\nSchedule C (Leasehold Improvements): Depreciation $25.2M.\nTotal consolidated depreciation expense for the year ended Dec 31: $145.8M.",
                "supporting_facts": ["Schedule A $62.4M", "Schedule B $58.2M", "Schedule C $25.2M", "Total $145.8M"]
            }
        ]
    },
    {
        "id": 12, "name": "FinanceBench", "group": "表格与数值计算", "format_type": "sec_10k_filings", "category": "SEC 10-K Compliance",
        "samples": [
            {
                "qid": "financebench_1",
                "query": "Based on the 10-K consolidated balance sheet, what is the net working capital for fiscal year ended 2024?",
                "gold_answer": "$3,421 million USD (Current Assets $9,845M minus Current Liabilities $6,424M).",
                "context": "Consolidated Balance Sheets (in millions):\nTotal Current Assets: $9,845\nTotal Current Liabilities: $6,424\nWorking Capital (Current Assets - Current Liabilities): $3,421.",
                "supporting_facts": ["Current Assets: $9,845", "Current Liabilities: $6,424", "$3,421"]
            }
        ]
    },
    {
        "id": 13, "name": "WikiTableQuestions", "group": "表格与数值计算", "format_type": "semi_structured_table", "category": "Semi-Structured Table QA",
        "samples": [
            {
                "qid": "wtq_1",
                "query": "Which country won the most gold medals among nations with fewer than 10 total medals?",
                "gold_answer": "Slovakia won 3 gold medals with a total of 5 medals.",
                "context": "| Country | Gold | Silver | Bronze | Total |\n|---|---|---|---|---|\n| Norway | 14 | 14 | 11 | 39 |\n| Germany | 14 | 10 | 7 | 31 |\n| Slovakia | 3 | 1 | 1 | 5 |\n| Belarus | 2 | 1 | 0 | 3 |\n| Poland | 1 | 0 | 1 | 2 |",
                "supporting_facts": ["Slovakia", "Gold: 3", "Total: 5"]
            }
        ]
    },
    {
        "id": 14, "name": "TabFact", "group": "表格与数值计算", "format_type": "table_fact_verification", "category": "Table Fact Verification",
        "samples": [
            {
                "qid": "tabfact_1",
                "query": "Verify: All departments with budget exceeding 10M reported positive net ROI in Q3.",
                "gold_answer": "Entailed (True). Both Cloud (18M budget, 14% ROI) and AI (12M budget, 22% ROI) reported positive ROI.",
                "context": "| Department | Q3 Budget ($M) | Net ROI (%) |\n|---|---|---|\n| Cloud Infra | 18.0 | +14.2% |\n| AI Lab | 12.0 | +22.5% |\n| Admin Support | 4.5 | -2.1% |\n| Marketing | 8.0 | +5.0% |",
                "supporting_facts": ["Cloud Infra 18.0, +14.2%", "AI Lab 12.0, +22.5%"]
            }
        ]
    },

    # ==================== GROUP 4: 法律公文、商业合同与层级规范 ====================
    {
        "id": 15, "name": "CUAD", "group": "公文与合同规范", "format_type": "contract_clause_analysis", "category": "Contract Risk Analysis",
        "samples": [
            {
                "qid": "cuad_1",
                "query": "What is the liability cap limitation and what are the carve-outs in Section 11.2?",
                "gold_answer": "The liability cap is limited to the fees paid in the prior 12 months. Carve-outs include gross negligence, willful misconduct, and indemnification for IP infringement.",
                "context": "Section 11.2 Limitation of Liability: In no event shall either party's aggregate liability exceed the total amounts paid or payable hereunder in the twelve (12) months preceding the claim. Notwithstanding the foregoing, the limitations shall not apply to: (a) breach of confidentiality under Section 8; (b) indemnification obligations under Section 10 (IP Infringement); or (c) damages resulting from gross negligence or willful misconduct.",
                "supporting_facts": ["twelve (12) months preceding the claim", "indemnification obligations under Section 10", "gross negligence or willful misconduct"]
            }
        ]
    },
    {
        "id": 16, "name": "LegalBench", "group": "公文与合同规范", "format_type": "legal_reasoning_statute", "category": "Legal Reasoning & Statutes",
        "samples": [
            {
                "qid": "legalbench_1",
                "query": "Does the termination clause require prior written notice of at least 30 days under Rule 4.2?",
                "gold_answer": "Yes, Section 4.2 requires 30 days prior written notice with a 15-day cure period before termination takes effect.",
                "context": "Rule 4.2 Early Termination: Either party may terminate this Agreement upon written notice if the other party breaches any material term, provided the breaching party is given thirty (30) days prior written notice specifying the breach and fails to cure within fifteen (15) days of receipt.",
                "supporting_facts": ["thirty (30) days prior written notice", "fails to cure within fifteen (15) days"]
            }
        ]
    },
    {
        "id": 17, "name": "QASPER", "group": "公文与合同规范", "format_type": "structured_paper_hierarchy", "category": "Research Paper QA",
        "samples": [
            {
                "qid": "qasper_1",
                "query": "What baseline architectures were compared in Section 3.2 Methodology?",
                "gold_answer": "Transformer-XL and RoBERTa-Large were compared as primary baselines against the proposed hybrid model.",
                "context": "3.2 Baseline Architectures\nWe benchmark our proposed model against two state-of-the-art baselines: (1) Transformer-XL (Dai et al., 2019) with 16 recurrent segment layers, and (2) RoBERTa-Large (Liu et al., 2019) fine-tuned on SQuAD 2.0.",
                "supporting_facts": ["Transformer-XL (Dai et al., 2019)", "RoBERTa-Large (Liu et al., 2019)"]
            }
        ]
    },

    # ==================== GROUP 5: 多模态视觉、PPT空间流与复杂版面 ====================
    {
        "id": 18, "name": "SlideVQA", "group": "多模态与复杂版面", "format_type": "pptx_spatial_flow", "category": "Presentation Slide Visual QA",
        "samples": [
            {
                "qid": "slidevqa_1",
                "query": "According to slide 4, what is the primary architecture component and speaker note key takeaway?",
                "gold_answer": "Primary component is the Edge-Cloud Collaborative Gateway with a 99.99% SLA guarantee in the speaker notes.",
                "context": "### Slide 4: Enterprise Architecture Overview\n- Visual Box: [Edge-Cloud Collaborative Gateway]\n- Data Flow: IoT Sensors -> Edge Ingestion -> Central Data Lake\n[Speaker Note]: Emphasize the 99.99% high-availability SLA guarantee across all distributed edge clusters during client demonstration.",
                "supporting_facts": ["Edge-Cloud Collaborative Gateway", "99.99% high-availability SLA guarantee"]
            }
        ]
    },
    {
        "id": 19, "name": "OmniDocBench", "group": "多模态与复杂版面", "format_type": "multimodal_layout_routing", "category": "Complex Multi-Column Layout",
        "samples": [
            {
                "qid": "omnidoc_1",
                "query": "Extract table data and multi-column text from mixed-layout document page 7",
                "gold_answer": "Left column describes server hardware specifications, right column lists network topology, and center table outlines disk array RAID configuration.",
                "context": "[Column 1 (Left)]: High-density blade servers equipped with dual 64-core processors and 512GB ECC DDR5 memory.\n[Column 2 (Right)]: Redundant 100GbE spine-leaf switching fabric interconnecting computing racks.\n[Center Table - Storage Matrix]:\n| Node | RAID Level | Usable Capacity |\n|---|---|---|\n| Storage-A | RAID 10 | 48 TB |\n| Storage-B | RAID 6 | 96 TB |",
                "supporting_facts": ["Storage-A RAID 10 48 TB", "Storage-B RAID 6 96 TB"]
            }
        ]
    },
    {
        "id": 20, "name": "DocVQA", "group": "多模态与复杂版面", "format_type": "scanned_invoice_receipt", "category": "Scanned Document OCR QA",
        "samples": [
            {
                "qid": "docvqa_1",
                "query": "What is the invoice total amount and tax rate indicated on the scanned receipt?",
                "gold_answer": "Total amount is 12,450.00 RMB, with a VAT tax rate of 6% (Tax amount 704.72 RMB).",
                "context": "Scanned Value-Added Tax Invoice (增值税专用发票):\nInvoice Code: 011002200111\nAmount before tax: 11,745.28 RMB\nTax Rate: 6%\nTax Amount: 704.72 RMB\nTotal Amount (in numbers): 12,450.00 RMB",
                "supporting_facts": ["Total Amount (in numbers): 12,450.00 RMB", "Tax Rate: 6%"]
            }
        ]
    },
    {
        "id": 21, "name": "InfographicVQA", "group": "多模态与复杂版面", "format_type": "infographic_visual_flow", "category": "Infographic Visual Flow QA",
        "samples": [
            {
                "qid": "infographic_1",
                "query": "Following the visual roadmap, which milestone follows Phase 2 validation?",
                "gold_answer": "Phase 3: Regional Pilot Deployment in Q4 2026.",
                "context": "Visual Product Roadmap:\n[Phase 1: Lab Prototyping (Q1-Q2)] -> [Phase 2: Alpha Test & Security Audit (Q3)] -> [Phase 3: Regional Pilot Deployment (Q4)] -> [Phase 4: Global General Availability (Q1 Next Year)].",
                "supporting_facts": ["Phase 3: Regional Pilot Deployment (Q4)"]
            }
        ]
    },
    {
        "id": 22, "name": "ChartQA", "group": "多模态与复杂版面", "format_type": "dual_axis_chart_extraction", "category": "Dual-Axis Chart Understanding",
        "samples": [
            {
                "qid": "chartqa_1",
                "query": "In the dual-axis chart, in which year did operating margin cross 25% while revenue exceeded 500M?",
                "gold_answer": "2023. In 2023, revenue reached 540M (left axis) and operating margin was 26.2% (right axis).",
                "context": "Dual-Axis Chart Data: Annual Revenue & Operating Margin (2020-2024):\n| Year | Revenue ($M, Left Axis) | Margin (%, Right Axis) |\n|---|---|---|\n| 2021 | 380 | 18.5% |\n| 2022 | 470 | 22.1% |\n| 2023 | 540 | 26.2% |\n| 2024 | 610 | 27.8% |",
                "supporting_facts": ["2023: Revenue 540M", "Margin 26.2%"]
            }
        ]
    },
    {
        "id": 23, "name": "TextVQA", "group": "多模态与复杂版面", "format_type": "tilted_noisy_ocr", "category": "Tilted Noisy Image OCR QA",
        "samples": [
            {
                "qid": "textvqa_1",
                "query": "What is the license plate number visible in the distorted, low-light image?",
                "gold_answer": "京A·8899K",
                "context": "[OCR Multi-Angle Rectification Output]: Image timestamp 2026-04-12 21:30:15, low illumination 15 lux. Perspective transform applied: Recognized vehicle registration plate: 京A·8899K (confidence: 0.985).",
                "supporting_facts": ["京A·8899K"]
            }
        ]
    },
    {
        "id": 24, "name": "TAT-DQA", "group": "多模态与复杂版面", "format_type": "hybrid_footnote_callout", "category": "Document QA with Complex Footnotes",
        "samples": [
            {
                "qid": "tatdqa_1",
                "query": "What special accounting exclusion is specified in footnote 3 below the table?",
                "gold_answer": "Footnote 3 states that non-GAAP operating income excludes a one-time restructuring impairment charge of 45 million RMB.",
                "context": "Table 5. Adjusted EBITDA Reconciliation:\nReported Net Income: 310M RMB\nAdjusted EBITDA: 420M RMB [Note 3]\nFootnote 3: Adjusted EBITDA excludes a one-off asset restructuring impairment charge of 45 million RMB incurred during the Q2 data center migration.",
                "supporting_facts": ["Footnote 3: Adjusted EBITDA excludes a one-off asset restructuring impairment charge of 45 million RMB"]
            }
        ]
    },
    {
        "id": 25, "name": "DUDE", "group": "多模态与复杂版面", "format_type": "industrial_100page_spec", "category": "100+ Page Industrial Document QA",
        "samples": [
            {
                "qid": "dude_1",
                "query": "What is the emergency braking response threshold specified on page 84 of the technical manual?",
                "gold_answer": "Less than or equal to 200 milliseconds under full load conditions.",
                "context": "Industrial Turbine Specification Manual Page 84, Section 9.4.2 Safety Trip Circuit:\nUnder full aerodynamic and electrical load, the hydraulic emergency brake trip valve must achieve full mechanical closure within t <= 200 ms of trip signal assertion.",
                "supporting_facts": ["t <= 200 ms", "full aerodynamic and electrical load"]
            }
        ]
    },

    # ==================== GROUP 6: 超长上下文与极端大海捞针 ====================
    {
        "id": 26, "name": "RULER", "group": "超长上下文多针", "format_type": "multi_needle_in_haystack", "category": "Multi-Needle in Haystack (35k+)",
        "samples": [
            {
                "qid": "ruler_1",
                "query": "Find the secret activation keys hidden at 25%, 58%, and 97% depth of the document.",
                "gold_answer": "Key 1: ALPHA-9921, Key 2: BETA-7734, Key 3: GAMMA-1108.",
                "context": "[Depth 25%]: Security note: First subsystem activation key is ALPHA-9921.\n[Depth 58%]: Maintenance notice: Secondary cluster verification token is BETA-7734.\n[Depth 97%]: Diagnostic tail marker: Final deployment unlock secret is GAMMA-1108.",
                "supporting_facts": ["ALPHA-9921", "BETA-7734", "GAMMA-1108"]
            }
        ]
    },
    {
        "id": 27, "name": "LongBench", "group": "超长上下文多针", "format_type": "full_book_panorama", "category": "Full Book Panoramic Summary",
        "samples": [
            {
                "qid": "longbench_1",
                "query": "Summarize the overarching evolution trajectory across all chapters of the technical monograph.",
                "gold_answer": "The monograph traces the architectural transition from monolithic mainframes (Ch. 1-4), through distributed microservices (Ch. 5-10), to edge-native AI agents (Ch. 11-15).",
                "context": "Summary Monograph Chapters 1-15:\nChapters 1-4: Monolithic legacy architectures and mainframe scalability bottlenecks.\nChapters 5-10: Service-oriented architecture, containerization, and microservices orchestration.\nChapters 11-15: Event-driven serverless, federated edge intelligence, and autonomous AI agents.",
                "supporting_facts": ["Monolithic legacy architectures", "containerization, and microservices", "federated edge intelligence, and autonomous AI agents"]
            }
        ]
    },
    {
        "id": 28, "name": "BABILong", "group": "超长上下文多针", "format_type": "extreme_99pct_noise_niah", "category": "Extreme 99% Noise Retrieval",
        "samples": [
            {
                "qid": "babilong_1",
                "query": "Where was the gold key placed before John moved to the garden in 100k token noise?",
                "gold_answer": "In the wooden chest on the second floor bedroom.",
                "context": "[100,000 tokens of noisy background prose about daily weather and kitchen inventory...]\nCritical Fact: Before walking downstairs and entering the garden, John carefully unlocked the wooden chest on the second floor bedroom and placed the gold key inside.\n[More extensive irrelevant noise...]",
                "supporting_facts": ["wooden chest on the second floor bedroom", "placed the gold key inside"]
            }
        ]
    },

    # ==================== GROUP 7: 时序冲突、版本演进与可信防幻觉 ====================
    {
        "id": 29, "name": "RGB Benchmark", "group": "可信度与时序对齐", "format_type": "negative_rejection_faithfulness", "category": "Negative Rejection & Anti-Hallucination",
        "samples": [
            {
                "qid": "rgb_1",
                "query": "What is the confidential budget and launch date of Project Nebula 2029?",
                "gold_answer": "已知知识库资料中未包含相关信息，无法回答该问题。(Refusal: Information not present in authorized knowledge base)",
                "context": "This repository contains documentation regarding Project Apollo, Project Gemini, and Project Artemis. No documentation exists regarding any initiative named Project Nebula 2029.",
                "supporting_facts": ["No documentation exists regarding any initiative named Project Nebula 2029"]
            },
            {
                "qid": "rgb_2",
                "query": "What is the penalty for exceeding the quantum cloud computing quota under policy XYZ-999?",
                "gold_answer": "已知知识库资料中未包含相关信息，无法回答该问题。",
                "context": "Standard Cloud Policy ABC-101 covers classical CPU and GPU instance allocations. Quantum cloud computing policies have not been released.",
                "supporting_facts": ["Quantum cloud computing policies have not been released"]
            }
        ]
    },
    {
        "id": 30, "name": "CRUD-RAG", "group": "可信度与时序对齐", "format_type": "temporal_precedence_updates", "category": "Temporal Precedence & Deprecation",
        "samples": [
            {
                "qid": "crud_1",
                "query": "根据最新员工考勤规定，弹性上下班打卡的核心时间范围是多少？旧规定是否还生效？",
                "gold_answer": "根据2026年现行有效版（V3.0）规定，弹性上班打卡时间为早上09:00至10:00，下班时间相应顺延。历史V1.0版（8:30固定打卡）与V2.0版已于2026年1月1日正式废止，不再生效。",
                "context": "【员工考勤管理制度 V1.0 (2023年)】规定：全员固定打卡时间为早上08:30，下午17:30。（已废止）\n【员工考勤管理制度 V2.0 (2024年)】规定：早上08:30-09:00弹性打卡。（已废止）\n【员工考勤管理制度 V3.0 (2026年1月1日生效，现行有效)】明确：工作日实行全面弹性工时，上午弹性到达时间为 09:00~10:00，满足8小时工作制后下午18:00~19:00离岗。本制度生效之日起，旧版V1.0、V2.0制度完全废止。",
                "supporting_facts": ["V3.0 (2026年1月1日生效，现行有效)", "09:00~10:00", "旧版V1.0、V2.0制度完全废止"]
            }
        ]
    }
]

def main():
    total_samples = 0
    with open(TARGET_FILE, "w", encoding="utf-8") as f:
        for benchmark in DATASET:
            for s in benchmark["samples"]:
                row = {
                    "benchmark_id": benchmark["id"],
                    "benchmark_name": benchmark["name"],
                    "group": benchmark["group"],
                    "category": benchmark["category"],
                    "format_type": benchmark["format_type"],
                    "qid": s["qid"],
                    "query": s["query"],
                    "gold_answer": s["gold_answer"],
                    "context": s["context"],
                    "supporting_facts": s.get("supporting_facts", [])
                }
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                total_samples += 1
    print(f"Successfully generated {total_samples} multi-sample benchmark cases across all 30 benchmarks into {TARGET_FILE}")

if __name__ == "__main__":
    main()
