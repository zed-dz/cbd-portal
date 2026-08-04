-- Seed the CBD Schedule of Rates 2026/27 into the company default rate card.
-- Source: CBD_Schedule_of_Rates_2026_27_Line_Items.csv (owner-supplied 2026-08-04).
-- 89 line items. Every one is copied onto each new client by
-- trg_clients_apply_default_rates.
--
-- Three deliberate renames. The printed card carries the same description twice
-- at DIFFERENT rates, distinguished only by which section it sits in. Because
-- apply_default_rate_card_to_client() matches on description to avoid
-- duplicating a client's line, identical names would silently drop the second
-- rate — so the section is folded into the description:
--   "Bolt on Rubber Pads / Slew & Height"  $11.40 wet hire  vs  $37.55 attachment
--   "VENM"                                 $28.85 T&D       vs  $57.70 rigid
--   "ENM"                                  $38.10 T&D       vs  $76.20 rigid
--
-- POR / POA / "1 hour" are not numbers, so those rates are NULL and the meaning
-- is kept in notes. Materials, floatage and the surcharge are single-rate items,
-- so B and C are NULL rather than 0 — a 0 would look like a real free rate.

-- CBD only. MRA and Hecate are different businesses with their own cards.
delete from public.default_rate_card;

insert into public.default_rate_card (role_name, uom, rate_a, rate_b, rate_c, category, notes, sort_order) values
-- LABOUR
('General Labour',                              'hour',  60.15,   85.05,   103.50, 'labour', null, 10),
('Skilled Labourer',                            'hour',  73.05,   95.00,   110.25, 'labour', null, 20),
('Water Cart / Bogie Driver',                   'hour',  77.70,   96.40,   112.80, 'labour', null, 30),
('Multi-Skilled Operator',                      'hour',  84.25,  104.05,   119.25, 'labour', null, 40),
('Dogman',                                      'hour',  84.30,  111.85,   139.25, 'labour', null, 50),
('Civil Leading Hand',                          'hour',  92.40,  117.80,   173.35, 'labour', null, 60),
('Tradesman (Concreter/Drainer/Electrician)',   'hour',  96.10,  122.45,   140.80, 'labour', null, 70),
('Foreman / Site Supervisor',                   'hour', 110.75,  131.90,   180.40, 'labour', null, 80),
('Supervisor Pipelayer',                        'hour', 131.25,  153.00,   183.75, 'labour', null, 90),
('Fitter / Mechanic (inc. travel)',             'hour', 117.70,  151.25,   159.75, 'labour', null, 100),
('Site Engineer',                               'hour', 132.85,  175.35,   168.00, 'labour', null, 110),
('Project Manager',                             'hour', 154.85,  195.85,   188.70, 'labour', null, 120),
('HSEQ Manager',                                'shift',1407.60, 1548.35,  1785.00,'labour', null, 130),
('Site Vehicle',                                'shift',  79.15,   79.15,    79.15, 'labour', null, 140),
('Travel Allowance to Site (Sydney Metro)',     'shift',  47.00,   47.00,    47.00, 'labour', null, 150),
('LAFHA',                                       'shift', 300.00,  300.00,   300.00, 'labour', null, 160),

-- PLANT & MACHINERY — WET HIRE
('1T - 7T Excavator',                           'hour', 119.00,  164.75,   176.20, 'plant', null, 170),
('5-6T Rubber Duck / Skid Steer / Belly Dumper','hour', 143.00,  188.75,   200.20, 'plant', null, 180),
('8T Excavator',                                'hour', 121.80,  167.35,   178.75, 'plant', null, 190),
('12T Excavator',                               'hour', 130.95,  176.45,   187.85, 'plant', null, 200),
('13T - 14T Excavator',                         'hour', 137.75,  183.30,   194.70, 'plant', null, 210),
('13-14T Knuckle Boom',                         'hour', 142.30,  187.85,   199.25, 'plant', null, 220),
('13-14T Rubber Duck (Wheeled Excavator)',      'hour', 153.70,  199.25,   210.60, 'plant', null, 230),
('20T Excavator',                               'hour', 150.30,  196.15,   207.20, 'plant', null, 240),
('24T Excavator',                               'hour', 153.70,  199.25,   210.60, 'plant', null, 250),
('23T Zero Swing Excavator',                    'hour', 175.35,  220.85,   216.30, 'plant', null, 260),
('30T Excavator',                               'hour', 175.35,  220.85,   232.25, 'plant', null, 270),
('30T Zero Swing Excavator',                    'hour', 212.90,  258.45,   269.80, 'plant', null, 280),
('36T Excavator',                               'hour', 213.95,  308.90,   271.15, 'plant', null, 290),
('50T Excavator',                               'hour', 263.10,  308.90,   320.30, 'plant', null, 300),
('70T Excavator',                               'hour',   null,    null,     null, 'plant', 'Price on Request', 310),
('Scraper',                                     'hour',   null,    null,     null, 'plant', 'Price on Request', 320),
('D6 Dozer',                                    'hour',   null,    null,     null, 'plant', 'Price on Request', 330),
('D8 Dozer',                                    'hour',   null,    null,     null, 'plant', 'Price on Request', 340),
('Dumpers up to 40T',                           'hour',   null,    null,     null, 'plant', 'Price on Request', 350),
('Bolt on Rubber Pads / Slew & Height (Wet Hire)','hour', 11.40,   11.40,    11.40, 'plant', null, 360),
('Trencher - Vermeer RT 95',                    'hour', 228.80,  274.55,   286.00, 'plant', null, 370),
('140M Grader',                                 'hour', 188.75,  234.50,   245.95, 'plant', null, 380),
('GPS',                                         'hour',  45.30,   45.30,    45.30, 'plant', null, 390),
('UTS',                                         'hour',  68.00,   68.00,    68.00, 'plant', null, 400),
('GPS MM Control System',                       'hour',  90.65,   90.65,    90.65, 'plant', null, 410),
('Water Carts - 1200 Litres',                   'hour',  98.30,  129.40,   170.75, 'plant', null, 420),
('Water Carts - 6000 Litres',                   'hour', 129.40,  160.40,   191.45, 'plant', null, 430),

-- ADDITIONAL PLANT & ATTACHMENTS (flat across all shifts)
('Bolt on Rubber Pads / Slew & Height (Attachment)','hour', 37.55,  37.55,   37.55, 'attachments', 'All Shifts', 440),
('1T - 4T Excavator Hammer',                    'hour',  93.95,   93.95,    93.95, 'attachments', 'All Shifts', 450),
('5T - 7T Excavator Hammer',                    'hour', 112.70,  112.70,   112.70, 'attachments', 'All Shifts', 460),
('8T - 12T Excavator Hammer',                   'hour', 150.30,  150.30,   150.30, 'attachments', 'All Shifts', 470),
('13T Excavator Hammer',                        'hour', 200.40,  200.40,   200.40, 'attachments', 'All Shifts', 480),
('20T Excavator Hammer',                        'hour', 244.20,  244.20,   244.20, 'attachments', 'All Shifts', 490),
('24T Excavator Hammer',                        'hour', 244.20,  244.20,   244.20, 'attachments', 'All Shifts', 500),
('30T Excavator Hammer',                        'hour', 281.80,  281.80,   281.80, 'attachments', 'All Shifts', 510),
('36T Excavator Hammer',                        'hour', 281.80,  281.80,   281.80, 'attachments', 'All Shifts', 520),
('48T Excavator Hammer',                        'hour', 350.65,  350.65,   350.65, 'attachments', 'All Shifts', 530),
('2T Tipper',                                   'hour', 258.75,  258.75,   258.75, 'attachments', 'All Shifts', 540),
('8T Tipper',                                   'hour', 306.85,  306.85,   306.85, 'attachments', 'All Shifts', 550),
('6T Dumper',                                   'hour', 181.60,  181.60,   181.60, 'attachments', 'All Shifts', 560),
('9T Dumper',                                   'hour', 200.40,  200.40,   200.40, 'attachments', 'All Shifts', 570),
('9T - 40T Dumper',                             'hour', 688.80,  688.80,   688.80, 'attachments', 'All Shifts', 580),
('Positrack',                                   'hour', 414.00,  414.00,   414.00, 'attachments', 'All Shifts', 590),
('Bobcat',                                      'hour', 414.00,  414.00,   414.00, 'attachments', 'All Shifts', 600),
('Broom Attachment',                            'hour',  82.80,   82.80,    82.80, 'attachments', 'All Shifts', 610),
('Confined Space Equipment',                    'hour', 250.45,  250.45,   250.45, 'attachments', 'All Shifts', 620),
('Power Saws',                                  'hour', 250.45,  250.45,   250.45, 'attachments', 'All Shifts', 630),
('Tool Truck',                                  'hour', 155.25,  155.25,   155.25, 'attachments', 'All Shifts', 640),
('Remote Control Trench Roller',                'hour', 288.05,  288.05,   288.05, 'attachments', 'All Shifts', 650),
('400kg-600kg Plate Compactor',                 'hour', 225.40,  225.40,   225.40, 'attachments', 'All Shifts', 660),
('DN225 EF/Butt Welding Equipment',             'hour',1308.70, 1308.70,  1308.70, 'attachments', 'All Shifts', 670),
('DN630 EF/Butt Welding Equipment',             'hour',1584.20, 1584.20,  1584.20, 'attachments', 'All Shifts', 680),

-- MATERIALS & TIPPING (single rate)
('VENM (T&D)',                                  'ton',   28.85,    null,     null, 'materials', 'T&D rates', 690),
('ENM (T&D)',                                   'ton',   38.10,    null,     null, 'materials', 'T&D rates', 700),
('VENM (Rigid)',                                'ton',   57.70,    null,     null, 'materials', 'Rigid rates', 710),
('ENM (Rigid)',                                 'ton',   76.20,    null,     null, 'materials', 'Rigid rates', 720),
('GSW (non-putrescible)',                       'ton',  283.25,    null,     null, 'materials', 'T&D rates', 730),
('GSW (putrescible)',                           'ton',  509.85,    null,     null, 'materials', 'T&D rates', 740),
('GSW (Restricted)',                            'ton',  458.35,    null,     null, 'materials', 'T&D rates', 750),
('GSW (Hazardous)',                             'ton',  695.25,    null,     null, 'materials', 'T&D rates', 760),
('GSW (Asbestos soils)',                        'ton',  283.25,    null,     null, 'materials', 'T&D rates', 770),
('GSW (Asbestos Bonded)',                       'ton',  324.45,    null,     null, 'materials', 'T&D rates', 780),
('GSW (Recyclable)',                            'ton',   84.45,    null,     null, 'materials', 'T&D rates', 790),

-- FLOATAGE / MOBILISATION
('Floatage <6T Dumper (or equivalent)',         'each way', 850.00, null, null, 'floatage', 'To/From Sydney Metro', 800),
('Floatage >9T Dumper',                         'each way',1500.00, null, null, 'floatage', 'To/From Sydney Metro', 810),
('Floatage <16T Excavator (or equivalent)',     'each way', 850.00, null, null, 'floatage', 'To/From Sydney Metro', 820),
('Floatage >16T Excavator (up to 30T)',         'each way',1250.00, null, null, 'floatage', 'To/From Sydney Metro', 830),
('Floatage >30T Excavator',                     'each way',   null, null, null, 'floatage', 'POA — To/From Sydney Metro', 840),
('Floatage Scrapers & Dozers',                  'each way',   null, null, null, 'floatage', 'POA — To/From Sydney Metro', 850),
('Floatage Grader Hire',                        'each way', 850.00, null, null, 'floatage', 'To/From Sydney Metro', 860),
('Truck/Tippers travel time allowance',         'hour',       null, null, null, 'floatage', 'Additional — 1 hour allowed', 870),
('Crew to Site (Mobilisation / Demobilisation)','each way',5500.00, null, null, 'floatage', 'Flat rate minimum', 880),

-- SURCHARGE
('Regional & Travel surcharge (outside Sydney Metro >50km)','%', 10, null, null, 'surcharge', 'Percent on Labour and Wet Hire rates', 890);

-- The catch-all A/B/C a new client starts on, before any line item applies.
-- General Labour is the card's baseline rate.
update public.payroll_config set config_value = '60.15',  updated_at = now() where config_key = 'default_client_rate_a';
update public.payroll_config set config_value = '85.05',  updated_at = now() where config_key = 'default_client_rate_b';
update public.payroll_config set config_value = '103.50', updated_at = now() where config_key = 'default_client_rate_c';
