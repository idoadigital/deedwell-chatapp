-- Website validation gets a first-class, versioned test report artifact
-- (spec §8): every build records exactly what was checked and what failed.
ALTER TABLE artifacts DROP CONSTRAINT artifacts_type_check;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_type_check CHECK (type IN
  ('compliance_matrix','grant_section','export_package','application_plan','budget',
   'logic_model','review_report','compliance_report','website_brief','website_test_report'));
