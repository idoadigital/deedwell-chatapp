-- Google validates nonprofits through Goodstack now; the TechSoup validation
-- token is obsolete and Google no longer accepts it. Remove stored tokens so
-- they stop appearing in the Mission Profile, the collected-data views and
-- the prompts. (org_facts.status has no retired/rejected value to use.)
DELETE FROM org_facts WHERE fact_key = 'techsoup_validation_token';
